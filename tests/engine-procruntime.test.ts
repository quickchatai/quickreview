// P2.3: the runtime port over a `pi` child process. A fake pi script plays back
// a recorded stream (tests/fixtures/engine-proc/pi-stdout.jsonl); the events
// file procRuntime writes is byte-identical to the one the pre-port runPi wrote
// for the same stream (pi-events.golden.jsonl was captured from that runPi).
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuntimeUnsupportedError, type SessionSpec } from "../src/engine/port.js";
import { procArgv, procRuntime } from "../src/engine/procruntime.js";
import { judgePiArgv, runJudgeSession } from "../src/bench/runner.js";

const FIXTURES = resolve(import.meta.dirname, "fixtures", "engine-proc");
const FAKE_PI = join(FIXTURES, "fake-pi.sh");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "procruntime-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function specIn(over: Partial<SessionSpec> = {}): SessionSpec {
  return {
    cwd: dir,
    env: { PATH: process.env["PATH"] },
    model: "m",
    eventsFile: join(dir, "pi-events.jsonl"),
    stderrFile: join(dir, "pi-stderr.log"),
    limits: { timeoutMs: 20_000 },
    ...over,
  };
}

/** A pi that records its argv and stdin, then prints `body` on stdout. */
function recordingPi(body: string): { bin: string; calls: string; stdin: string } {
  const bin = join(dir, "rec-pi");
  const calls = join(dir, "calls.log");
  const stdin = join(dir, "stdin.log");
  writeFileSync(
    bin,
    `#!/bin/sh\necho "$*" >> ${JSON.stringify(calls)}\ncat >> ${JSON.stringify(stdin)}\n${body}\n`,
  );
  chmodSync(bin, 0o755);
  return { bin, calls, stdin };
}

describe("procRuntime and the tool uid (D32)", () => {
  const saved = process.env["QCR_TOOL_UID_REQUIRED"];
  afterEach(() => {
    if (saved === undefined) delete process.env["QCR_TOOL_UID_REQUIRED"];
    else process.env["QCR_TOOL_UID_REQUIRED"] = saved;
  });

  it("refuses to start pi when the entrypoint could not split the uid, and says why", async () => {
    const { bin, calls } = recordingPi("echo done");
    process.env["QCR_TOOL_UID_REQUIRED"] = "1";
    const session = await procRuntime({ bin }).create(specIn());
    const r = await session.prompt("prompt");
    await session.dispose();
    expect(r.code).toBeNull();
    expect(r.streamError).toContain("--cap-add SETUID");
    expect(() => readFileSync(calls)).toThrow(); // pi never ran
    expect(readFileSync(join(dir, "pi-stderr.log"), "utf8")).toContain("pi not started");
  });
});

describe("procRuntime event stream", () => {
  it("writes the same events file the pre-port runPi wrote, byte for byte", async () => {
    const session = await procRuntime({ bin: FAKE_PI }).create(
      specIn({ limits: { timeoutMs: 20_000, capUsd: 100 } }),
    );
    const heard: string[] = [];
    session.subscribe((e) => heard.push(String(e["type"])));
    const r = await session.prompt("prompt");
    await session.dispose();
    expect(r.code).toBe(0);
    expect(r.capped).toBe(false);
    expect(r.spentUsd).toBeCloseTo(0.75);
    expect(readFileSync(join(dir, "pi-events.jsonl"))).toEqual(
      readFileSync(join(FIXTURES, "pi-events.golden.jsonl")),
    );
    expect(readFileSync(join(dir, "pi-stderr.log"), "utf8")).toBe("pi: warning fixture\n");
    // Subscribers hear what was written, and not the dropped *_update lines.
    expect(heard).toEqual([
      "session",
      "message_start",
      "message_end",
      "tool_execution_end",
      "crlf",
      "agent_end",
    ]);
    expect(session.stats()).toMatchObject({ turns: 1, busy: false });
    expect(session.stats().spentUsd).toBeCloseTo(0.75);
  });
});

describe("procRuntime turns", () => {
  it("sends the prompt on stdin, and a follow-up is a --continue respawn with its text on argv", async () => {
    const pi = recordingPi('echo \'{"type":"agent_end"}\'');
    const session = await procRuntime({ bin: pi.bin }).create(
      specIn({
        name: "n",
        systemPromptFile: "/sys.md",
        extensions: ["/e/a.ts", "/e/b.ts"],
        sessionDir: join(dir, "session"),
        cliFlags: ["--approve", "-ne", "-ns"],
      }),
    );
    await session.prompt("the order");
    const d = await session.followUp("finish up");
    expect(d.status).toBe("handled");
    await session.dispose();
    const [first, second] = readFileSync(pi.calls, "utf8").trim().split("\n");
    const base = `--approve -ne -ns --model m --session-dir ${join(dir, "session")} --system-prompt /sys.md --extension /e/a.ts --extension /e/b.ts --name n --mode json`;
    expect(first).toBe(`${base} -p`);
    expect(second).toBe(`${base} --continue -p finish up`);
    expect(readFileSync(pi.stdin, "utf8")).toBe("the order");
  });

  it("queues a follow-up sent while a turn runs, and runs it behind that turn", async () => {
    const pi = recordingPi("sleep 1");
    const session = await procRuntime({ bin: pi.bin }).create(specIn());
    const first = session.prompt("p");
    const queued = await session.followUp("later");
    expect(queued).toEqual({ status: "queued" });
    expect(session.stats().busy).toBe(true);
    await first;
    // The queued turn's result lands in stats(); wait for the queue to drain.
    while (session.stats().busy) await new Promise((r) => setTimeout(r, 20));
    await session.dispose();
    expect(readFileSync(pi.calls, "utf8").trim().split("\n")).toHaveLength(2);
    expect(session.stats().turns).toBe(2);
  });

  it("applies a per-turn timeout over the session's", async () => {
    const pi = recordingPi("sleep 30");
    const session = await procRuntime({ bin: pi.bin }).create(specIn());
    const r = await session.prompt("p", { timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    await session.dispose();
  });

  it("types steer and resume as unsupported, and refuses agentsFiles rather than dropping them", async () => {
    const runtime = procRuntime({ bin: FAKE_PI });
    const session = await runtime.create(specIn());
    expect(await session.steer("now")).toMatchObject({ status: "unsupported" });
    await session.dispose();
    await expect(runtime.resume("/x.jsonl", specIn())).rejects.toBeInstanceOf(
      RuntimeUnsupportedError,
    );
    await expect(
      runtime.create(specIn({ agentsFiles: [{ path: "AGENTS.md", content: "x" }] })),
    ).rejects.toBeInstanceOf(RuntimeUnsupportedError);
  });

  it("aborts the running turn, lens children with it", async () => {
    const pi = recordingPi("sleep 60 & wait");
    const session = await procRuntime({ bin: pi.bin }).create(specIn());
    const turn = session.prompt("p");
    await new Promise((r) => setTimeout(r, 300));
    await session.abort();
    const r = await turn;
    expect(r.code).toBeNull();
    expect(r.timedOut).toBe(false);
    await session.dispose();
  });

  it("dispose kills a running turn and is idempotent; a disposed session takes nothing", async () => {
    const pi = recordingPi("sleep 60");
    const session = await procRuntime({ bin: pi.bin }).create(specIn());
    const turn = session.prompt("p");
    await new Promise((r) => setTimeout(r, 300));
    await session.dispose();
    await session.dispose();
    expect((await turn).code).toBeNull();
    await expect(session.followUp("x")).rejects.toThrow(/disposed/);
  });

  it("reads the session file and id from the session dir", async () => {
    const pi = recordingPi(
      `sd=""; prev=""; for a in "$@"; do [ "$prev" = "--session-dir" ] && sd="$a"; prev="$a"; done\nmkdir -p "$sd"; echo '{"type":"session","id":"abc-1"}' > "$sd/s.jsonl"`,
    );
    const sessionDir = join(dir, "session");
    const session = await procRuntime({ bin: pi.bin }).create(specIn({ sessionDir }));
    expect(session.sessionFile).toBeNull();
    await session.prompt("p");
    expect(session.sessionFile).toBe(join(sessionDir, "s.jsonl"));
    expect(session.id).toBe("abc-1");
    await session.dispose();
  });
});

describe("the callers' spawn flags", () => {
  it("keeps the one-shot flag order the pre-port runner used", () => {
    expect(
      procArgv({
        ...specIn({ model: "m1", name: "oneshot-7", sessionDir: "/o/session" }),
        systemPromptFile: "/o/system-prompt.md",
        extensions: ["/r/extensions/bash-guard.ts", "/r/extensions/ledger-pin.ts"],
        cliFlags: ["--approve", "-ne", "-ns"],
      }),
    ).toEqual([
      "--approve",
      "-ne",
      "-ns",
      "--model",
      "m1",
      "--session-dir",
      "/o/session",
      "--system-prompt",
      "/o/system-prompt.md",
      "--extension",
      "/r/extensions/bash-guard.ts",
      "--extension",
      "/r/extensions/ledger-pin.ts",
      "--name",
      "oneshot-7",
      "--mode",
      "json",
    ]);
  });

  it("keeps the judge's flags: read-only tools, one extension, no session or project files", () => {
    const argv = judgePiArgv("/r", "m2");
    expect([...argv].sort()).toEqual(
      [
        "-p",
        "--no-session",
        "--no-approve",
        "--no-extensions",
        "--extension",
        "/r/extensions/bash-guard.ts",
        "--tools",
        "read,bash",
        "--no-skills",
        "--no-context-files",
        "--no-prompt-templates",
        "--no-themes",
        "--model",
        "m2",
        "--mode",
        "json",
      ].sort(),
    );
    expect(argv.at(-1)).toBe("-p");
  });
});

describe("an injected runtime", () => {
  it("hosts the judge session, which is disposed after its one prompt", async () => {
    const seen: { spec?: SessionSpec; prompt?: string; disposed?: boolean } = {};
    const result = { code: 0, timedOut: false, streamError: null };
    const r = await runJudgeSession("judge this", {
      root: "/r",
      cwd: "/case",
      model: "m",
      env: {},
      eventsPath: "/runs/c.r1.events.jsonl",
      timeoutMs: 5,
      runtime: {
        create: (spec) => {
          seen.spec = spec;
          return Promise.resolve({
            id: "x",
            sessionFile: null,
            prompt: (t) => {
              seen.prompt = t;
              return Promise.resolve(result);
            },
            followUp: () => Promise.resolve({ status: "unsupported", reason: "" }),
            steer: () => Promise.resolve({ status: "unsupported", reason: "" }),
            abort: () => Promise.resolve(),
            subscribe: () => () => {},
            stats: () => ({ turns: 0, busy: false, spentUsd: 0, last: null }),
            dispose: () => {
              seen.disposed = true;
              return Promise.resolve();
            },
          });
        },
        resume: () => Promise.reject(new Error("unused")),
      },
    });
    expect(r).toBe(result);
    expect(seen.prompt).toBe("judge this");
    expect(seen.disposed).toBe(true);
    expect(seen.spec).toMatchObject({
      cwd: "/case",
      model: "m",
      eventsFile: "/runs/c.r1.events.jsonl",
      stderrFile: "/runs/c.r1.events.stderr.log",
      tools: ["read", "bash"],
    });
  });
});

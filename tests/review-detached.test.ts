// `qcr review start | status | stop` (src/reviewdetach.ts): detached runs for
// plugins. Time, pids, the launcher and the review itself are injected; one
// test really spawns a detached node stub to show the run outlives its starter.
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sdkStubArgs, writeSdkDriverStub, type SdkStubMode } from "./helpers/sdk-driver-stub.js";
import { waitFor } from "./helpers/wait-for.js";
import { validate } from "./helpers/json-schema-lite.js";
import type { LensActivity } from "@quickchatai/pi-quickreview/src/engine/lens/activity.js";
import type { LensRequest, LensRun } from "@quickchatai/pi-quickreview/src/engine/lens/runlens.js";
import { lensToolDefinitions } from "@quickchatai/pi-quickreview/src/engine/lens/tool.js";
import { LensWave, type WaveRunner } from "@quickchatai/pi-quickreview/src/engine/lens/wave.js";
import { liveRoundDir } from "@quickchatai/pi-quickreview/src/live/events.js";
import { createLiveWriter } from "@quickchatai/pi-quickreview/src/live/writer.js";
import {
  CONTAINER_START_GRACE_MS,
  identifyTarget,
  launchDetached,
  runIsAlive,
  driverSignals,
  runDetachedChild,
  runDetachedVerb,
  type DetachDeps,
} from "../src/reviewdetach.js";

const tmp = mkdtempSync(join(tmpdir(), "review-detached-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

interface Harness {
  deps: DetachDeps;
  lines: string[];
  launched: Array<{ runId: string; argv: string[] }>;
  killed: Array<{ pid: number; sig: string }>;
  clock: { t: number };
  live: Set<number>;
}

let n = 0;
function harness(over: Partial<DetachDeps> = {}): Harness {
  const home = join(tmp, `home${n++}`);
  const lines: string[] = [];
  const launched: Harness["launched"] = [];
  const killed: Harness["killed"] = [];
  const clock = { t: 1_000_000 };
  const live = new Set<number>();
  let pid = 4000;
  let ids = 0;
  const deps: DetachDeps = {
    home,
    out: (l) => lines.push(l),
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
    },
    newId: () => {
      clock.t += 1000;
      return `run${++ids}`;
    },
    alive: (p) => live.has(p),
    kill: (p, sig) => {
      killed.push({ pid: p, sig });
      live.delete(p);
    },
    identify: (rest) =>
      rest.includes("bad")
        ? { ok: false, error: "not a git repository" }
        : {
            ok: true,
            key: `branch:o/r@${rest.includes("other") ? "other" : "feature"}`,
            label: "feature",
          },
    launch: (l) => {
      launched.push({ runId: l.runId, argv: l.argv });
      pid += 1;
      live.add(pid);
      return { ok: true, pid };
    },
    ...over,
  };
  return { deps, lines, launched, killed, clock, live };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (h: Harness): Record<string, any> => JSON.parse(h.lines[h.lines.length - 1]!);

/** Pretend the child ran to its end. */
function finish(h: Harness, runId: string, code: number, result: unknown): void {
  const dir = join(h.deps.home, "runs", runId);
  writeFileSync(join(dir, "output.jsonl"), `${JSON.stringify(result)}\n`);
  writeFileSync(join(dir, "exit.json"), JSON.stringify({ code }));
  h.live.clear();
}

describe("start", () => {
  it("returns at once with a run id and launches the review as json", async () => {
    const h = harness();
    expect(await runDetachedVerb("start", ["--base", "main"], true, h.deps)).toBe(0);
    expect(json(h)).toMatchObject({ ok: true, run_id: "run1", state: "running" });
    expect(h.launched).toHaveLength(1);
    expect(h.launched[0]!.argv).toEqual(["--base", "main"]);
  });

  it("refuses a second concurrent review of the same target, clearly", async () => {
    const h = harness();
    await runDetachedVerb("start", [], true, h.deps);
    h.lines.length = 0;
    expect(await runDetachedVerb("start", [], true, h.deps)).toBe(1);
    const j = json(h);
    expect(j.ok).toBe(false);
    expect(j.errors[0]).toMatch(/already running.*run1/);
    expect(h.launched).toHaveLength(1);
  });

  it("allows a different target, and the same target once the first has finished", async () => {
    const h = harness();
    await runDetachedVerb("start", [], true, h.deps);
    expect(await runDetachedVerb("start", ["--base", "other"], true, h.deps)).toBe(0);
    finish(h, "run1", 0, { ok: true });
    expect(await runDetachedVerb("start", [], true, h.deps)).toBe(0);
  });

  it("replaces a lock whose run died", async () => {
    const h = harness();
    await runDetachedVerb("start", [], true, h.deps);
    h.live.clear();
    expect(await runDetachedVerb("start", [], true, h.deps)).toBe(0);
  });

  it("does not reclaim a lock whose starter has not yet published its run", async () => {
    const h = harness();
    await runDetachedVerb("start", [], true, h.deps);
    const lock = join(h.deps.home, "locks", readdirSync(join(h.deps.home, "locks"))[0]!);
    // the starter wrote the lock a moment ago and has no run.json yet
    writeFileSync(lock, JSON.stringify({ run_id: "unpublished", at: h.clock.t }));
    expect(await runDetachedVerb("start", [], true, h.deps)).toBe(1);
    expect(h.launched).toHaveLength(1);
    // once the claim is old, it is a dead starter's and is replaced
    h.clock.t += CONTAINER_START_GRACE_MS + 1;
    expect(await runDetachedVerb("start", [], true, h.deps)).toBe(0);
  });

  it("exits 2 on bad review arguments and on --preview, 1 when the target cannot be resolved", async () => {
    const h = harness();
    expect(await runDetachedVerb("start", ["--nonsense"], true, h.deps)).toBe(2);
    expect(await runDetachedVerb("start", ["--preview"], true, h.deps)).toBe(2);
    // a debug round needs the terminal pi takes over: never a detached run
    expect(await runDetachedVerb("start", ["--debug-pi"], true, h.deps)).toBe(2);
    expect(await runDetachedVerb("start", ["--base", "bad"], true, h.deps)).toBe(1);
    expect(h.launched).toHaveLength(0);
  });

  it("starts the watchdog with the child's pid, and a watchdog that throws does not refuse the run", async () => {
    const watched: Array<{ key: string; pid: number }> = [];
    const h = harness({
      watch: (w) => {
        watched.push({ key: w.key, pid: w.pid });
        throw new Error("no watchdog");
      },
    });
    expect(await runDetachedVerb("start", [], true, h.deps)).toBe(0);
    expect(watched).toEqual([{ key: "branch:o/r@feature", pid: 4001 }]);
  });

  it("is refused (1) when the launch fails, and leaves no lock", async () => {
    const h = harness({ launch: () => ({ ok: false, error: "spawn ENOENT" }) });
    expect(await runDetachedVerb("start", [], true, h.deps)).toBe(1);
    const ok = harness();
    expect(await runDetachedVerb("start", [], true, ok.deps)).toBe(0);
  });
});

describe("status", () => {
  it("reports a running review without waiting (exit 0)", async () => {
    const h = harness();
    await runDetachedVerb("start", [], true, h.deps);
    expect(await runDetachedVerb("status", [], true, h.deps)).toBe(0);
    expect(json(h)).toMatchObject({ ok: true, run_id: "run1", state: "running" });
  });

  it("returns the findings JSON of a done run (exit 0)", async () => {
    const h = harness();
    await runDetachedVerb("start", [], true, h.deps);
    finish(h, "run1", 0, { ok: true, findings: { high: [{ title: "x" }] } });
    expect(await runDetachedVerb("status", ["--wait"], true, h.deps)).toBe(0);
    expect(json(h)).toMatchObject({
      state: "done",
      exit_code: 0,
      result: { ok: true, findings: { high: [{ title: "x" }] } },
    });
  });

  it("--wait polls until the run finishes", async () => {
    const h = harness();
    await runDetachedVerb("start", [], true, h.deps);
    let polls = 0;
    h.deps.sleep = async (ms) => {
      h.clock.t += ms;
      if (++polls === 3) finish(h, "run1", 0, { ok: true });
    };
    expect(await runDetachedVerb("status", ["--wait"], true, h.deps)).toBe(0);
    expect(polls).toBe(3);
  });

  it("exits 1 for a run the review refused or failed, still carrying its json", async () => {
    const h = harness();
    await runDetachedVerb("start", [], true, h.deps);
    finish(h, "run1", 1, { ok: false, errors: ["declined"] });
    expect(await runDetachedVerb("status", [], true, h.deps)).toBe(1);
    expect(json(h)).toMatchObject({
      state: "failed",
      exit_code: 1,
      result: { errors: ["declined"] },
    });
  });

  it("exits 1 for a run that died without a result", async () => {
    const h = harness();
    await runDetachedVerb("start", [], true, h.deps);
    h.live.clear();
    expect(await runDetachedVerb("status", ["--wait"], true, h.deps)).toBe(1);
    expect(json(h).state).toBe("failed");
  });

  it("exits 3 when --wait times out", async () => {
    const h = harness();
    await runDetachedVerb("start", [], true, h.deps);
    expect(await runDetachedVerb("status", ["--wait", "--timeout", "5"], true, h.deps)).toBe(3);
    expect(json(h)).toMatchObject({ timed_out: true, state: "running" });
  });

  it("exits 2 on usage errors and 1 when there is no such run", async () => {
    const h = harness();
    expect(await runDetachedVerb("status", ["--timeout", "5"], true, h.deps)).toBe(2);
    expect(await runDetachedVerb("status", ["--wait", "--timeout", "x"], true, h.deps)).toBe(2);
    expect(await runDetachedVerb("status", ["--what"], true, h.deps)).toBe(2);
    expect(await runDetachedVerb("status", [], true, h.deps)).toBe(1);
    expect(await runDetachedVerb("status", ["nope"], true, h.deps)).toBe(1);
  });

  it("selects a run by id", async () => {
    const h = harness();
    await runDetachedVerb("start", [], true, h.deps);
    await runDetachedVerb("start", ["--base", "other"], true, h.deps);
    await runDetachedVerb("status", ["run1"], true, h.deps);
    expect(json(h).run_id).toBe("run1");
    await runDetachedVerb("status", [], true, h.deps);
    expect(json(h).run_id).toBe("run2");
  });
});

describe("status: live lens activity", () => {
  /** A finished pass, as the runner returns it. */
  const ran = (id: string, agent: string, exitCode: number, activity: LensActivity): LensRun => ({
    text: exitCode === 0 ? "No findings." : "",
    activity,
    result: {
      id,
      agent,
      model: "faux/m",
      usage: { input: 0, output: 0, cacheRead: 0, cost: 0 },
      messages: [],
      exitCode,
      ...(exitCode === 0 ? {} : { stopReason: "error", errorMessage: "provider failed" }),
    },
  });

  it("carries each running lens's tool, its file and a growing count; a finished lens keeps its count, a failed one reads failed", async () => {
    const h = harness();
    await runDetachedVerb("start", [], true, h.deps);
    // The run's round log, written as the core writes it: the main session's
    // events, the real lens tool's progress updates among them.
    const root = join(h.deps.home, "runs", "run1", "work", "review");
    const sink = createLiveWriter({
      dir: liveRoundDir(root, "review-feature", 1),
      now: () => h.clock.t,
      coalesceMs: 60_000,
    }).main({ key: "review-feature", round: 1, pr: 0, session: "review-feature" });
    const passes: Array<{ request: LensRequest; finish: (run: LensRun) => void }> = [];
    const runner: WaveRunner = {
      run: (request) => new Promise((finish) => passes.push({ request, finish })),
    };
    // Every change told at once (the tool's own pace is ACTIVITY_UPDATE_MS).
    const [lens] = lensToolDefinitions({
      runner,
      wave: new LensWave(),
      env: {},
      activityUpdateMs: 0,
    });
    const args = {
      tasks: [
        { agent: "pass-security--sol-high", task: "a" },
        { agent: "pass-tests--sol-high", task: "b" },
      ],
    };
    const call = { toolCallId: "c1", toolName: "lens", args };
    sink.feed({ type: "agent_start" });
    sink.feed({ type: "tool_execution_start", ...call });
    const done = lens!.execute("c1", args, undefined, (partialResult: unknown) =>
      sink.feed({ type: "tool_execution_update", ...call, partialResult }),
    );
    await waitFor(() => passes.length === 2, "both passes to start");
    const schema = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "schemas", "review-result.v1.json"), "utf8"),
    ) as Record<string, unknown>;
    const lenses = async (): Promise<Array<Record<string, unknown>>> => {
      sink.flush();
      h.lines.length = 0;
      expect(await runDetachedVerb("status", [], true, h.deps)).toBe(0);
      // the payload a plugin reads, as its schema describes it
      expect(validate(schema, json(h))).toEqual([]);
      return json(h).progress.live.agents;
    };
    const [security, tests] = passes as [(typeof passes)[0], (typeof passes)[0]];

    // The security lens is reading a file; the tests lens has done nothing yet.
    security.request.onActivity!({
      durationMs: 5_000,
      toolCount: 3,
      tool: "read",
      args: "src/x.ts",
      target: "src/x.ts",
      toolRunning: true,
    });
    expect(await lenses()).toEqual([
      {
        agent: "pass-security--sol-high",
        status: "running",
        duration_ms: 5_000,
        tool_count: 3,
        current_tool: "read: src/x.ts",
        current_target: "src/x.ts",
        line: "security · read src/x.ts · 3 tools · 0:05",
      },
      {
        agent: "pass-tests--sol-high",
        status: "running",
        duration_ms: 0,
        tool_count: 0,
        line: "tests · starting · 0:00",
      },
    ]);

    // Seven seconds on: the count grows, the tool and its path move on, and a
    // running lens's time counts from its start between its own updates.
    h.clock.t += 7_000;
    security.request.onActivity!({
      durationMs: 6_000,
      toolCount: 4,
      tool: "grep",
      args: "TODO",
      target: "src",
      toolRunning: true,
    });
    tests.request.onActivity!({
      durationMs: 6_500,
      toolCount: 1,
      tool: "bash",
      args: "git diff",
      toolRunning: true,
    });
    const later = await lenses();
    expect(later[0]).toMatchObject({
      status: "running",
      tool_count: 4,
      current_tool: "grep: TODO",
      current_target: "src",
      duration_ms: 7_000,
    });
    // a tool with no path names none
    expect(later[1]).toMatchObject({
      status: "running",
      tool_count: 1,
      current_tool: "bash: git diff",
    });
    expect(later[1]).not.toHaveProperty("current_target");
    // the human status names each running lens and what it is doing
    h.lines.length = 0;
    await runDetachedVerb("status", [], false, h.deps);
    expect(h.lines.join("\n")).toMatch(/^ {2}security · grep src · 4 tools · 0:07$/m);
    expect(h.lines.join("\n")).toMatch(/^ {2}tests · bash · 1 tool · 0:07$/m);

    // One lens finishes, the other fails: their final counts and outcomes stay.
    security.finish(
      ran("r-sec", "pass-security--sol-high", 0, {
        durationMs: 9_000,
        toolCount: 5,
        toolRunning: false,
      }),
    );
    tests.finish(
      ran("r-tst", "pass-tests--sol-high", 1, {
        durationMs: 8_000,
        toolCount: 2,
        toolRunning: false,
      }),
    );
    const result = await done;
    sink.feed({ type: "tool_execution_end", ...call, result, isError: false });
    const ended = await lenses();
    expect(ended[0]).toMatchObject({ status: "completed", tool_count: 5, duration_ms: 9_000 });
    expect(ended[0]).not.toHaveProperty("current_target");
    expect(ended[0]!["line"]).toBe("security · done · 5 tools · 0:09");
    expect(ended[1]).toMatchObject({ status: "failed", tool_count: 2, duration_ms: 8_000 });
    expect(ended[1]!["line"]).toBe("tests · failed · 2 tools · 0:08");
  });
});

describe("stop", () => {
  it("cancels a running review: kills its group, frees the target (exit 0)", async () => {
    const h = harness();
    await runDetachedVerb("start", [], true, h.deps);
    expect(await runDetachedVerb("stop", [], true, h.deps)).toBe(0);
    expect(h.killed).toEqual([{ pid: 4001, sig: "SIGTERM" }]);
    await runDetachedVerb("status", [], true, h.deps);
    expect(json(h).state).toBe("stopped");
    expect(await runDetachedVerb("start", [], true, h.deps)).toBe(0);
  });

  it("is refused (1) when nothing is running, and usage (2) on a stray flag", async () => {
    const h = harness();
    expect(await runDetachedVerb("stop", [], true, h.deps)).toBe(1);
    await runDetachedVerb("start", [], true, h.deps);
    finish(h, "run1", 0, { ok: true });
    expect(await runDetachedVerb("stop", [], true, h.deps)).toBe(1);
    expect(await runDetachedVerb("stop", ["--wait"], true, h.deps)).toBe(2);
  });
});

describe("the real child", () => {
  it("a launched node process outlives the call that started it, and status --wait returns its findings", async () => {
    const home = join(tmp, "real");
    const stub = join(tmp, "stub.mjs");
    const release = join(tmp, "real-release"); // the child works until the test lets it finish
    const dist = join(process.cwd(), "dist", "src", "reviewdetach.js");
    writeFileSync(
      stub,
      `import { runDetachedChild } from ${JSON.stringify(dist)};
await runDetachedChild({ dir: process.argv[2], key: process.argv[3], run: async (out) => {
  while (!(await import("node:fs")).existsSync(${JSON.stringify(release)})) await new Promise((r) => setTimeout(r, 20));
  out(JSON.stringify({ ok: true, findings: { high: [{ title: "from the child" }] } }));
  return 0;
} });
`,
    );
    const lines: string[] = [];
    const deps: DetachDeps = {
      home,
      out: (l) => lines.push(l),
      now: Date.now,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      newId: () => "real1",
      alive: (p) => {
        try {
          process.kill(p, 0);
          return true;
        } catch {
          return false;
        }
      },
      kill: (p, s) => process.kill(-p, s),
      identify: () => ({ ok: true, key: "branch:o/r@x", label: "x" }),
      launch: (l) =>
        launchDetached({
          command: process.execPath,
          args: [stub, l.dir, l.key],
          dir: l.dir,
          env: process.env,
        }),
    };
    // start returns while the child is still working: it did not wait for it
    expect(await runDetachedVerb("start", [], true, deps)).toBe(0);
    expect(await runDetachedVerb("status", [], true, deps)).toBe(0);
    expect(JSON.parse(lines[lines.length - 1]!).state).toBe("running");
    writeFileSync(release, "");
    expect(await runDetachedVerb("status", ["--wait", "--timeout", "20"], true, deps)).toBe(0);
    const j = JSON.parse(lines[lines.length - 1]!);
    expect(j.state).toBe("done");
    expect(j.result.findings.high[0].title).toBe("from the child");
  });
});

describe("identifyTarget", () => {
  it("keys a branch and the uncommitted tree apart, and a PR by repo and number", () => {
    const repo = join(tmp, "repo");
    mkdirSync(repo);
    const g = (...a: string[]): void => {
      execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@e.x", ...a], { cwd: repo });
    };
    g("init", "-q", "-b", "main");
    writeFileSync(join(repo, "a"), "1\n");
    g("add", "-A");
    g("commit", "-q", "-m", "base");
    g("checkout", "-q", "-b", "feature");
    writeFileSync(join(repo, "a"), "2\n");
    g("commit", "-q", "-am", "change");
    writeFileSync(join(repo, "a"), "3\n");
    const b = identifyTarget([], repo);
    const u = identifyTarget(["--uncommitted"], repo);
    const p = identifyTarget(["12", "--repo", "o/r"], repo);
    expect(b.ok && u.ok && p.ok).toBe(true);
    if (b.ok && u.ok && p.ok) {
      expect(new Set([b.key, u.key, p.key]).size).toBe(3);
      expect(p.key).toBe("pr:o/r#12");
      expect(identifyTarget([], repo)).toEqual(b);
    }
    expect(identifyTarget([], tmp).ok).toBe(false);
  });
});

describe("identifyTarget for a diff", () => {
  it("keys a diff file by its content, needs no repository, and refuses a piped one", () => {
    const dir = join(tmp, "difftarget");
    mkdirSync(dir);
    writeFileSync(join(dir, "a.patch"), "one\n");
    writeFileSync(join(dir, "b.patch"), "two\n");
    const a = identifyTarget(["--diff", "a.patch"], dir);
    const b = identifyTarget(["--diff", "b.patch"], dir);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.key).toMatch(/^diff:[0-9a-f]{40}$/);
      expect(a.key).not.toBe(b.key);
    }
    const piped = identifyTarget(["--diff", "-"], dir);
    expect(piped.ok).toBe(false);
    expect(!piped.ok && piped.error).toMatch(/foreground/);
    expect(identifyTarget(["--diff", "missing.patch"], dir).ok).toBe(false);
  });
});

describe("runIsAlive", () => {
  it("calls a run with neither pid nor container dead once its start grace has passed", () => {
    const deps = { alive: () => false, liveContainers: () => null, now: () => 100_000 };
    const run = { pid: null, started_at: 100_000 - CONTAINER_START_GRACE_MS + 1 };
    expect(runIsAlive(run, deps)).toBe(true);
    expect(runIsAlive({ ...run, started_at: 100_000 - CONTAINER_START_GRACE_MS }, deps)).toBe(
      false,
    );
  });
});

describe("runDetachedChild", () => {
  it("leaves a target lock that a newer run now holds", async () => {
    const home = join(tmp, "child2");
    const dir = join(home, "runs", "old");
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(home, "locks"), { recursive: true });
    const { createHash } = await import("node:crypto");
    const key = "k2";
    const real = join(
      home,
      "locks",
      `${createHash("sha256").update(key).digest("hex").slice(0, 20)}.json`,
    );
    writeFileSync(real, JSON.stringify({ run_id: "new" }));
    await runDetachedChild({ dir, key, run: async () => 0 });
    expect(JSON.parse(readFileSync(real, "utf8")).run_id).toBe("new");
    writeFileSync(real, JSON.stringify({ run_id: "old" }));
    await runDetachedChild({ dir, key, run: async () => 0 });
    expect(() => readFileSync(real, "utf8")).toThrow();
  });

  it("records exit code 1 and the error when the run throws", async () => {
    const dir = join(tmp, "child", "runs", "c1");
    mkdirSync(dir, { recursive: true });
    await runDetachedChild({
      dir,
      key: "k",
      run: async () => {
        throw new Error("boom");
      },
    });
    expect(JSON.parse(readFileSync(join(dir, "exit.json"), "utf8")).code).toBe(1);
    expect(readFileSync(join(dir, "output.jsonl"), "utf8")).toContain("boom");
  });

  it("keeps a heartbeat file while the run lasts, for the watchdog to read", async () => {
    const dir = join(tmp, "child", "runs", "c2");
    mkdirSync(dir, { recursive: true });
    let during: unknown = null;
    await runDetachedChild({
      dir,
      key: "k",
      run: async () => {
        during = JSON.parse(readFileSync(join(dir, "heartbeat.json"), "utf8"));
        return 0;
      },
    });
    expect(during).toMatchObject({ seq: 1, pid: process.pid, deadline_at: null, pgids: [] });
  });

  it("writes a beat the moment a turn's deadline is tracked, so a loop that freezes at once still leaves it", async () => {
    const { trackDeadline } = await import("@quickchatai/pi-quickreview/src/heartbeat.js");
    const dir = join(tmp, "child", "runs", "c3");
    mkdirSync(dir, { recursive: true });
    let during: { seq: number; deadline_at: number | null } | null = null;
    await runDetachedChild({
      dir,
      key: "k",
      run: async () => {
        const read = () => JSON.parse(readFileSync(join(dir, "heartbeat.json"), "utf8"));
        const release = trackDeadline(4_242_424);
        during = read();
        release();
        return 0;
      },
    });
    expect(during).toMatchObject({ seq: 2, deadline_at: 4_242_424 });
  });

  it("rewrites the beat when a deadline is released, so a shorter turn's deadline shows at once", async () => {
    const { trackDeadline } = await import("@quickchatai/pi-quickreview/src/heartbeat.js");
    const dir = join(tmp, "child", "runs", "c4");
    mkdirSync(dir, { recursive: true });
    let after: { deadline_at: number | null } | null = null;
    await runDetachedChild({
      dir,
      key: "k",
      run: async () => {
        const read = () => JSON.parse(readFileSync(join(dir, "heartbeat.json"), "utf8"));
        const releaseLong = trackDeadline(9_000_000);
        trackDeadline(1_000_000);
        releaseLong();
        after = read();
        return 0;
      },
    });
    expect(after).toMatchObject({ deadline_at: 1_000_000 });
  });
});

describe("driverSignals", () => {
  it("the first signal stops the sessions then exits 130; a second exits at once", async () => {
    const calls: string[] = [];
    const onSignal = driverSignals({
      exit: (code) => calls.push(`exit ${code}`),
      stopSessions: async () => void calls.push("stop"),
    });
    onSignal();
    expect(calls).toEqual(["stop"]);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toEqual(["stop", "exit 130"]);
    onSignal();
    expect(calls).toEqual(["stop", "exit 130", "exit 130"]);
  });

  it("runDetachedChild listens for SIGINT and SIGTERM while the run lasts, then lets go", async () => {
    const dir = join(tmp, "sig", "runs", "s1");
    mkdirSync(dir, { recursive: true });
    const on: string[] = [];
    const off: string[] = [];
    await runDetachedChild({
      dir,
      key: "k",
      run: async () => {
        expect(on).toEqual(["SIGINT", "SIGTERM"]);
        return 0;
      },
      proc: {
        on: ((sig: string) => on.push(sig)) as never,
        off: ((sig: string) => off.push(sig)) as never,
        exit: (() => undefined) as never,
      },
    });
    expect(off).toEqual(["SIGINT", "SIGTERM"]);
  });
});

describe("driverSignals on the SDK runtime", () => {
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it("the first signal aborts, then disposes, then exits 130", async () => {
    const calls: string[] = [];
    const onSignal = driverSignals({
      exit: (code) => calls.push(`exit ${code}`),
      stopSessions: async () => {
        calls.push("abort");
        await flush();
        calls.push("dispose");
      },
    });
    onSignal();
    expect(calls).toEqual(["abort"]);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual(["abort", "dispose", "exit 130"]);
  });

  it("exits 130 even when the stop throws, and a second signal exits at once, mid-stop", async () => {
    const calls: string[] = [];
    const never = new Promise<void>(() => {});
    const wedged = driverSignals({
      exit: (code) => calls.push(`exit ${code}`),
      stopSessions: () => never,
    });
    wedged();
    await flush();
    expect(calls).toEqual([]);
    wedged();
    expect(calls).toEqual(["exit 130"]);

    const calls2: string[] = [];
    const throwing = driverSignals({
      exit: (code) => calls2.push(`exit ${code}`),
      stopSessions: () => Promise.reject(new Error("boom")),
    });
    throwing();
    await new Promise((r) => setTimeout(r, 10));
    expect(calls2).toEqual(["exit 130"]);
  });
});

describe("a detached review on the SDK runtime", () => {
  const alive = (p: number): boolean => {
    try {
      process.kill(p, 0);
      return true;
    } catch {
      return false;
    }
  };
  const until = async (cond: () => boolean, ms = 10_000): Promise<boolean> => {
    for (let i = 0; i < ms / 50 && !cond(); i++) await new Promise((r) => setTimeout(r, 50));
    return cond();
  };
  const readNum = (file: string): number | null => {
    try {
      const n = Number(readFileSync(file, "utf8").trim());
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  };
  /** Real deps over a stub driver in `mode`; the registry is `name`'s. */
  async function rig(name: string, mode: SdkStubMode) {
    const home = join(tmp, name);
    mkdirSync(home, { recursive: true });
    const stub = writeSdkDriverStub(home);
    const lines: string[] = [];
    let pid = 0;
    const deps: DetachDeps = {
      home,
      out: (l) => lines.push(l),
      now: Date.now,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      newId: () => name,
      alive,
      kill: (p, s) => process.kill(-p, s),
      identify: () => ({ ok: true, key: `branch:o/r@${name}`, label: name }),
      launch: (l) => {
        const r = launchDetached({
          command: process.execPath,
          args: [stub, ...sdkStubArgs(l, mode, process.cwd())],
          dir: l.dir,
          env: process.env,
        });
        if (r.ok) pid = r.pid;
        return r;
      },
    };
    const dir = join(home, "runs", name);
    return { deps, dir, pid: () => pid, lines };
  }

  it("stop aborts the session mid-turn, disposes it and exits 130: no driver, no bash child, no lock left; status says stopped", async () => {
    const r = await rig("sdk-stop", "hang");
    expect(await runDetachedVerb("start", [], true, r.deps)).toBe(0);
    const driver = r.pid();
    expect(await until(() => readNum(join(r.dir, "bash-pid")) !== null)).toBe(true);
    const bash = readNum(join(r.dir, "bash-pid"))!;
    expect(alive(driver) && alive(bash)).toBe(true);

    expect(await runDetachedVerb("stop", [], true, r.deps)).toBe(0);
    expect(await until(() => !alive(driver) && !alive(bash))).toBe(true);
    expect(readFileSync(join(r.dir, "exit-code"), "utf8")).toBe("130");

    // the run is stopped, its target is free again
    r.lines.length = 0;
    expect(await runDetachedVerb("status", [], true, r.deps)).toBe(1);
    expect(JSON.parse(r.lines[0]!)).toMatchObject({ state: "stopped", run_id: "sdk-stop" });
    expect(readdirSync(join(r.deps.home, "locks"))).toEqual([]);
  }, 30_000);

  it("a run that ends on its own leaves no handle: the process exits by itself, with its result recorded", async () => {
    const r = await rig("sdk-ok", "ok");
    expect(await runDetachedVerb("start", [], true, r.deps)).toBe(0);
    const driver = r.pid();
    expect(await until(() => !alive(driver), 20_000)).toBe(true);
    expect(readFileSync(join(r.dir, "exit-code"), "utf8")).toBe("0");
    expect(JSON.parse(readFileSync(join(r.dir, "exit.json"), "utf8"))).toEqual({ code: 0 });
    expect(readdirSync(join(r.deps.home, "locks"))).toEqual([]);
  }, 30_000);
});

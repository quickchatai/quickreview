// `qcr live` (src/livecli.ts) and the live part of `qcr review status`
// (src/reviewdetach.ts): both read a run's LiveEvent logs from disk.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { newRenderState, renderLiveEvent, runLive, type LiveCliDeps } from "../src/livecli.js";
import { liveRoundDir } from "../src/live/events.js";
import { createLiveWriter } from "../src/live/writer.js";
import { runDetachedVerb, type DetachDeps } from "../src/reviewdetach.js";

const tmp = mkdtempSync(join(tmpdir(), "live-cli-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
const sha = "e".repeat(64);

/** A registry home with one run whose work dir holds a live round. */
function registry(opts: { settle?: boolean; exit?: boolean } = {}): {
  home: string;
  runId: string;
  runRoot: string;
  roundDir: string;
} {
  const home = join(tmp, `home${n++}`);
  const runId = "20261001100000-abc123";
  const dir = join(home, "runs", runId);
  const runRoot = join(dir, "work", "20261001100001-pr7");
  mkdirSync(runRoot, { recursive: true });
  writeFileSync(
    join(dir, "run.json"),
    JSON.stringify({
      run_id: runId,
      key: "pr:o/r#7",
      label: "PR o/r#7",
      argv: [],
      pid: 4242,
      started_at: 1,
    }),
  );
  const roundDir = liveRoundDir(runRoot, "review-x", 2);
  const sink = createLiveWriter({ dir: roundDir, env: {} }).main({
    key: "review-x",
    round: 2,
    pr: 7,
    session: "review-x",
  });
  sink.feed({ type: "agent_start" });
  sink.feed({
    type: "message_start",
    message: {
      role: "user",
      content: [{ type: "text", text: `order <!-- qcr-command:c1:${sha} -->` }],
    },
  });
  sink.feed({
    type: "tool_execution_start",
    toolCallId: "t",
    toolName: "lens",
    args: { agent: "pass-security", task: "x" },
  });
  sink.feed({
    type: "tool_execution_update",
    toolCallId: "t",
    toolName: "lens",
    partialResult: {
      details: {
        results: [
          {
            agent: "pass-security",
            id: "L1",
            exitCode: -1,
            progress: { status: "running", toolCount: 3, lastMessage: "tracing the bearer" },
          },
        ],
      },
    },
  });
  sink.flush();
  sink.feed({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "thinking about it" },
  });
  if (opts.settle) {
    sink.feed({
      type: "tool_execution_end",
      toolCallId: "t",
      toolName: "lens",
      result: {
        details: {
          results: [
            {
              agent: "pass-security",
              id: "L1",
              exitCode: 0,
              progress: { status: "completed", toolCount: 5 },
            },
          ],
        },
      },
      isError: false,
    });
    sink.feed({ type: "agent_settled", aborted: false });
  }
  sink.close();
  createLiveWriter({ dir: roundDir })
    .lens("L1", { key: "review-x", round: 2, pr: 7, session: "review-x", agent: "pass-security" })
    .close();
  if (opts.exit) writeFileSync(join(dir, "exit.json"), JSON.stringify({ code: 0 }));
  return { home, runId, runRoot, roundDir };
}

function cliDeps(
  home: string,
  over: Partial<LiveCliDeps> = {},
): { deps: LiveCliDeps; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    deps: { home, out: (l) => lines.push(l), sleep: async () => {}, alive: () => true, ...over },
  };
}

describe("qcr live", () => {
  it("reads the newest run's main log as a transcript, naming the lens logs", async () => {
    const { home } = registry({ settle: true });
    const { deps, lines } = cliDeps(home);
    expect(await runLive([], false, deps)).toBe(0);
    const text = lines.join("\n");
    expect(text).toMatch(/session review-x \(review-x, round 2\)/);
    expect(text).toMatch(/> order/);
    expect(text).toMatch(/tool lens pass-security/);
    expect(text).toMatch(/pass-security running \(3 tools\) tracing the bearer/);
    expect(text).toMatch(/agent settled/);
    expect(text).toMatch(/lens logs: L1/);
  });

  it("reads one lens's log with --lens, and says which exist when the id is wrong", async () => {
    const { home, runId } = registry();
    const a = cliDeps(home);
    expect(await runLive([runId, "--lens", "L1"], false, a.deps)).toBe(0);
    expect(a.lines.join("\n")).toMatch(/lens pass-security L1/);
    const b = cliDeps(home);
    expect(await runLive([runId, "--lens", "nope"], false, b.deps)).toBe(1);
    expect(b.lines[0]).toMatch(/no lens log nope; this round has: L1/);
  });

  it("emits the raw events with --json, one per line", async () => {
    const { home, runId } = registry({ settle: true });
    const { deps, lines } = cliDeps(home);
    expect(await runLive([runId, "--json"], false, deps)).toBe(0);
    const events = lines.map((l) => JSON.parse(l));
    expect(events[0]).toMatchObject({ v: 1, seq: 1, type: "session_start" });
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
  });

  it("takes a run root or a round directory as well as a run id", async () => {
    const { runRoot, roundDir } = registry({ settle: true });
    for (const arg of [runRoot, roundDir]) {
      const { deps, lines } = cliDeps(join(tmp, "elsewhere"));
      expect(await runLive([arg], false, deps)).toBe(0);
      expect(lines.join("\n")).toMatch(/session review-x/);
    }
    const { deps } = cliDeps(join(tmp, "elsewhere"));
    expect(await runLive([runRoot, "--round", "9"], false, deps)).toBe(1);
  });

  it("follows what is appended until the session settles", async () => {
    const { home, runId, roundDir } = registry();
    let polls = 0;
    const { deps, lines } = cliDeps(home, {
      sleep: async () => {
        polls++;
        if (polls === 2) {
          const more = createLiveWriter({ dir: roundDir, env: {} }).main({
            key: "review-x",
            round: 2,
            pr: 7,
            session: "review-x",
          });
          more.feed({ type: "agent_settled", aborted: false });
          more.close();
        }
      },
    });
    expect(await runLive([runId, "--follow"], false, deps)).toBe(0);
    expect(polls).toBe(2);
    expect(lines.filter((l) => /agent settled/.test(l))).toHaveLength(1);
  });

  it("stops following a run that is over", async () => {
    const { home, runId } = registry({ exit: true });
    const { deps } = cliDeps(home);
    expect(await runLive([runId, "--follow"], false, deps)).toBe(0);
  });

  it("stops following a run whose driver died", async () => {
    const { home, runId } = registry();
    const { deps } = cliDeps(home, { alive: () => false });
    expect(await runLive([runId, "--follow"], false, deps)).toBe(0);
  });

  it("refuses clearly: no run, no log yet, bad arguments", async () => {
    const empty = cliDeps(join(tmp, "empty"));
    expect(await runLive([], false, empty.deps)).toBe(1);
    expect(empty.lines[0]).toMatch(/no review run to read/);
    const home = join(tmp, "nolog");
    mkdirSync(join(home, "runs", "r1"), { recursive: true });
    writeFileSync(join(home, "runs", "r1", "run.json"), JSON.stringify({ pid: null }));
    const nolog = cliDeps(home);
    expect(await runLive(["r1"], false, nolog.deps)).toBe(1);
    expect(nolog.lines[0]).toMatch(/no live log yet/);
    const bad = cliDeps(home);
    expect(await runLive(["--round", "x"], false, bad.deps)).toBe(2);
    expect(await runLive(["--wat"], false, bad.deps)).toBe(2);
    expect(await runLive(["--lens", "../x"], false, bad.deps)).toBe(2);
  });
});

describe("renderLiveEvent", () => {
  const at = "2026-10-01T10:00:00.000Z";
  it("prints streamed text once, not again at the message's end", () => {
    const state = newRenderState();
    const at1 = (e: object) => ({ v: 1 as const, seq: 1, at, ...e }) as never;
    renderLiveEvent(at1({ type: "message_start", role: "assistant" }), state);
    expect(renderLiveEvent(at1({ type: "message_delta", text: "hello\nthere" }), state)).toEqual([
      "    hello",
      "    there",
    ]);
    expect(
      renderLiveEvent(
        at1({
          type: "message_end",
          role: "assistant",
          text: "hello\nthere",
          stop_reason: "stop",
          usage: { input: 1, output: 1, cache_read: 0, cost_usd: 0.25 },
        }),
        state,
      ),
    ).toEqual(["10:00:00  assistant stop · $0.2500"]);
    // a message that never streamed (a process runtime) prints its text at the end
    renderLiveEvent(at1({ type: "message_start", role: "assistant" }), state);
    expect(
      renderLiveEvent(at1({ type: "message_end", role: "assistant", text: "whole" }), state),
    ).toEqual(["    whole"]);
  });
});

describe("qcr review status, live", () => {
  function deps(home: string): { deps: DetachDeps; lines: string[] } {
    const lines: string[] = [];
    return {
      lines,
      deps: {
        home,
        out: (l) => lines.push(l),
        now: () => 2_000_000,
        sleep: async () => {},
        newId: () => "x",
        alive: () => true,
        kill: () => {},
        identify: () => ({ ok: true, key: "k", label: "l" }),
        launch: () => ({ ok: true, pid: 1 }),
      },
    };
  }

  it("reports what a running review is doing from its live log, before any stage record exists", async () => {
    const { home, runId } = registry();
    const h = deps(home);
    expect(await runDetachedVerb("status", [runId], true, h.deps)).toBe(0);
    const out = JSON.parse(h.lines.at(-1)!);
    expect(out.state).toBe("running");
    expect(out.progress.lenses_started).toEqual(["pass-security"]);
    expect(out.progress.live).toMatchObject({
      round: 2,
      parent_status: "active",
      agents: [{ agent: "pass-security", status: "running", tool_count: 3 }],
    });
  });

  it("prints the running and finished lenses in the human report", async () => {
    const { home, runId } = registry();
    const h = deps(home);
    await runDetachedVerb("status", [runId], false, h.deps);
    expect(h.lines.at(-1)).toMatch(/running: pass-security/);
    expect(h.lines.at(-1)).toMatch(/now: /);
  });

  it("still answers for a run with no live log", async () => {
    const home = join(tmp, `home${n++}`);
    mkdirSync(join(home, "runs", "r1", "work", "w"), { recursive: true });
    writeFileSync(
      join(home, "runs", "r1", "run.json"),
      JSON.stringify({ run_id: "r1", key: "k", label: "l", argv: [], pid: 5, started_at: 1 }),
    );
    const h = deps(home);
    await runDetachedVerb("status", ["r1"], true, h.deps);
    expect(JSON.parse(h.lines.at(-1)!).progress).toBeNull();
  });
});

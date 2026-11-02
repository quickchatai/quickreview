// The security family's rows in the engine wave and in the live progress: a
// row that runs one strategy of its lens (the exploit chain's `delta`,
// `forward`, …) carries the strategy from its task file's name
// (`NN-<agent>@<strategy>.md`) to the launch unit, the live log and the
// round-progress snapshot, where the required-pass check reads it
// (tests/required-passes.test.ts); and the post-discovery rows (`tasks-post`,
// the chain's `compose`) are never part of the discovery wave — the session
// launches them, in a call of their own, once the wave has returned.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  planLaunch,
  taskPointer,
  unitKeys,
} from "@quickchatai/pi-quickreview/src/engine/lens/launch-plan.js";
import { roundLiveWriter } from "@quickchatai/pi-quickreview/src/engine/livewire.js";
import { readLiveEvents, LIVE_MAIN_FILE } from "@quickchatai/pi-quickreview/src/live/events.js";
import { projectRoundProgress } from "@quickchatai/pi-quickreview/src/live/projection.js";
import { createLiveWriter } from "@quickchatai/pi-quickreview/src/live/writer.js";
import { parseRoundProgress } from "@quickchatai/pi-quickreview/src/round-progress.js";

const CHAIN = "pass-sec-exploit-chain--sol-high";

let root: string;
let passes: string;
let tasks: string;
let post: string;

function write(dir: string, file: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), `# task ${file}\n`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qcr-security-wave-"));
  passes = join(root, "state", "pr-77-round-1-passes");
  tasks = join(passes, "tasks");
  post = join(passes, "tasks-post");
  write(tasks, "01-pass-baseline--sol-high.md");
  write(tasks, "02-pass-sec-access--sol-high.md");
  write(tasks, `03-${CHAIN}@delta.md`);
  write(tasks, `04-${CHAIN}@forward.md`);
  write(post, `01-${CHAIN}@compose.md`);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const env = () => ({ QCR_SANDBOX_ROOT: root });

describe("a strategy row's task file", () => {
  it("is a discovery row of its agent, carrying its strategy", () => {
    const p = planLaunch({ dirs: [tasks] }, env());
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.units.map((u) => [u.row, u.agent, u.strategy])).toEqual([
      [1, "pass-baseline--sol-high", undefined],
      [2, "pass-sec-access--sol-high", undefined],
      [3, CHAIN, "delta"],
      [4, CHAIN, "forward"],
    ]);
    expect(p.units[2]!.task).toBe(taskPointer(join(tasks, `03-${CHAIN}@delta.md`)));
  });

  it("answers to its agent with its strategy, so one chain row can be skipped alone", () => {
    const p = planLaunch({ dirs: [tasks], skip: [`${CHAIN}@forward`] }, env());
    expect(p.ok && p.skipped.map((u) => u.strategy)).toEqual(["forward"]);
    expect(p.ok && p.units.map((u) => u.strategy ?? null)).toEqual([null, null, "delta"]);
    // A row of a lens with one strategy keeps exactly its old keys.
    expect(unitKeys({ phase: "plan", row: 2, agent: "pass-a", file: "02-pass-a.md" })).toEqual([
      "02-pass-a.md",
      "02-pass-a",
      "2",
      "pass-a",
      "plan:*",
      "*",
    ]);
  });
});

describe("tasks-post is never part of the discovery wave", () => {
  // MUTATION: in resolveTaskDir, list the round's pass dir's tasks-post rows
  // with its tasks/ rows (or drop the post-with-others refusal in planLaunch) —
  // the compose row joins the wave and this fails.
  it("the round's pass dir and its tasks/ plan no post-discovery row", () => {
    for (const dirs of [[passes], [tasks]]) {
      const p = planLaunch({ dirs }, env());
      expect(p.ok).toBe(true);
      if (!p.ok) continue;
      expect(p.units.some((u) => u.strategy === "compose")).toBe(false);
      expect(p.units.every((u) => u.phase === "plan")).toBe(true);
    }
  });

  it("launches from tasks-post on its own, as the post phase", () => {
    const p = planLaunch({ dirs: [post], extra: { "post:1": "L1 a.py:3 — leak" } }, env());
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.units.map((u) => [u.phase, u.row, u.agent, u.strategy])).toEqual([
      ["post", 1, CHAIN, "compose"],
    ]);
    expect(p.units[0]!.task).toBe(
      `${taskPointer(join(post, `01-${CHAIN}@compose.md`))}\n\nL1 a.py:3 — leak`,
    );
  });

  it("refuses tasks-post beside the round's other task directories", () => {
    const p = planLaunch({ dirs: [tasks, post] }, env());
    expect(p.ok).toBe(false);
    expect(!p.ok && p.error).toContain("tasks-post launches on its own");
  });

  it("confines tasks-post to the session's own PR, as every task dir", () => {
    expect(planLaunch({ dirs: [post] }, { ...env(), QCR_PR: "78" }).ok).toBe(false);
    expect(planLaunch({ dirs: [post] }, { ...env(), QCR_PR: "77" }).ok).toBe(true);
  });
});

describe("the strategy and the post phase reach the round-progress snapshot", () => {
  const logs = mkdtempSync(join(tmpdir(), "qcr-security-wave-live-"));
  afterAll(() => rmSync(logs, { recursive: true, force: true }));
  let n = 0;
  const META = { key: "pr-77", round: 1, pr: 77, session: "pr-77" };
  const sha = "a".repeat(64);

  /** A session that runs `calls` (tool name, args, outcome per slot) after the
   * round's command, then settles. */
  function project(
    writer: ReturnType<typeof createLiveWriter>,
    calls: Array<{ tool: string; args: Record<string, unknown>; results: Array<[string, number]> }>,
  ) {
    const sink = writer.main(META);
    sink.feed({ type: "agent_start" });
    sink.feed({
      type: "message_start",
      message: {
        role: "user",
        content: [{ type: "text", text: `order <!-- qcr-command:cmd-77:${sha} -->` }],
      },
    });
    for (const [i, call] of calls.entries()) {
      sink.feed({
        type: "tool_execution_start",
        toolCallId: `c${i}`,
        toolName: call.tool,
        args: call.args,
      });
      sink.feed({
        type: "tool_execution_end",
        toolCallId: `c${i}`,
        toolName: call.tool,
        result: {
          details: {
            results: call.results.map(([agent, exitCode], j) => ({
              agent,
              id: `L${i}-${j}`,
              exitCode,
              progress: {
                status: exitCode === 0 ? "completed" : "failed",
                durationMs: 10,
                toolCount: 1,
              },
            })),
          },
        },
        isError: call.results.some(([, code]) => code !== 0),
      });
    }
    sink.feed({ type: "agent_settled", aborted: false });
    sink.close();
    const projection = projectRoundProgress(
      readLiveEvents(join(writer.dir, LIVE_MAIN_FILE)).events,
    );
    return parseRoundProgress(projection!.snapshotJson!);
  }

  it("a lens call on a task-file pointer records the row's phase and strategy", () => {
    const writer = createLiveWriter({ dir: join(logs, `r${n++}`) });
    const snapshot = project(writer, [
      {
        tool: "lens",
        args: {
          tasks: [
            { agent: CHAIN, task: taskPointer(join(tasks, `03-${CHAIN}@delta.md`)) },
            { agent: "pass-sec-access--sol-high", task: taskPointer(join(tasks, "02-x.md")) },
          ],
        },
        results: [
          [CHAIN, 1],
          ["pass-sec-access--sol-high", 0],
        ],
      },
      {
        tool: "lens",
        args: {
          agent: CHAIN,
          task: `${taskPointer(join(post, `01-${CHAIN}@compose.md`))}\n\nCHAIN LEADS\nL1 a.py:3`,
        },
        results: [[CHAIN, 0]],
      },
    ]);
    expect(snapshot).toBeDefined();
    expect(snapshot!.agents.map((a) => [a.agent, a.phase, a.strategy, a.status])).toEqual([
      [CHAIN, "plan", "delta", "failed"],
      ["pass-sec-access--sol-high", "plan", undefined, "completed"],
      [CHAIN, "post", "compose", "completed"],
    ]);
  });

  it("a lens_wave call carries the strategies the launch plan resolved", () => {
    const writer = roundLiveWriter({ root: join(logs, `w${n++}`), key: "pr-77", round: 1 }, env());
    const snapshot = project(writer, [
      {
        tool: "lens_wave",
        args: { dirs: [tasks] },
        results: [
          ["pass-baseline--sol-high", 0],
          ["pass-sec-access--sol-high", 0],
          [CHAIN, 0],
          [CHAIN, 1],
        ],
      },
    ]);
    expect(snapshot!.agents.map((a) => [a.strategy ?? null, a.status])).toEqual([
      [null, "completed"],
      [null, "completed"],
      ["delta", "completed"],
      ["forward", "failed"],
    ]);
  });

  it("the parser accepts the post phase and a strategy, and refuses a malformed strategy", () => {
    const writer = createLiveWriter({ dir: join(logs, `r${n++}`) });
    const snapshot = project(writer, [
      {
        tool: "lens",
        args: { agent: CHAIN, task: taskPointer(join(post, `01-${CHAIN}@compose.md`)) },
        results: [[CHAIN, 0]],
      },
    ]);
    expect(snapshot).toBeDefined();
    const bad = structuredClone(snapshot!);
    (bad.agents[0] as unknown as Record<string, unknown>).strategy = 7;
    expect(parseRoundProgress(JSON.stringify(bad))).toBeUndefined();
    const unknownPhase = structuredClone(snapshot!);
    (unknownPhase.agents[0] as unknown as Record<string, unknown>).phase = "later";
    expect(parseRoundProgress(JSON.stringify(unknownPhase))).toBeUndefined();
  });
});

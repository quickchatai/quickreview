// P4.5: our lens tools, `lens` and `lens_wave` (D3), with the join semantics of
// D8. Everything runs the real pi SDK on pi-ai's faux provider (no model, no
// network): a 20-lens fan-out, a join that never relaunches a planned row, the
// tools hosted as customTools on an SDK main session, and a replay of what the
// tools return through the consumers that count lenses (cost, stages, usage,
// round progress).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createBashGuard } from "../extensions/bash-guard.js";
import { interactiveLens, lensRunConfigFromEnv, lensTools } from "../extensions/lens.js";
import { usageFromEvents, stagesFromEvents } from "../src/bench/aacr.js";
import { EventCostMeter } from "../src/bench/cost.js";
import { lensOutputsFromEvents } from "../src/bench/whatif.js";
import { engineLensTools } from "../src/engine/lens/engine-tools.js";
import { planLaunch, type LaunchUnit } from "../src/engine/lens/launch-plan.js";
import { loadBuiltAgents } from "../src/engine/lens/registry.js";
import {
  createLensRunner,
  type LensRun,
  type LensRunConfig,
  type LensRunner,
} from "../src/engine/lens/runlens.js";
import {
  LENS_TOOL,
  LENS_WAVE_TOOL,
  lensToolDefinitions,
  type LensToolDeps,
} from "../src/engine/lens/tool.js";
import { LensWave, launchWave, type WaveRunner } from "../src/engine/lens/wave.js";
import { roundSdkExtras } from "../src/engine/roundsdk.js";
import { DEFAULT_TOOLS } from "../src/engine/pisdk.js";
import { isLensTool, parseLedger } from "../src/lensresult.js";
import { createHostRig, useOfflineGuard, type HostRig } from "./pi-canary/harness.js";

useOfflineGuard();

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const agentFile = (name: string): string =>
  `---\nname: ${name}\ndescription: ${name} lens\nmodel: faux/faux-1\ntools: read, bash\n---\nYou are ${name}. Report findings.\n`;

let rig: HostRig;
let dir: string;
let env: Record<string, string | undefined>;
let sessionsMade: number;
let made: AgentSession[];
let unhandled: unknown[];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};

const PASSES = "state/pr-7-round-1-passes";

beforeEach(async () => {
  rig = await createHostRig();
  dir = mkdtempSync(join(tmpdir(), "lens-tool-"));
  mkdirSync(join(dir, "agents"));
  for (const a of ["pass-a", "pass-b"]) writeFileSync(join(dir, "agents", `${a}.md`), agentFile(a));
  // 20 planned rows, a pass-a / pass-b alternation, and two optional rows.
  mkdirSync(join(dir, PASSES, "tasks"), { recursive: true });
  mkdirSync(join(dir, PASSES, "tasks-optional"), { recursive: true });
  for (let i = 1; i <= 20; i++)
    writeFileSync(
      join(dir, PASSES, "tasks", `${String(i).padStart(2, "0")}-${i % 2 ? "pass-a" : "pass-b"}.md`),
      `row ${i}\n`,
    );
  for (let i = 1; i <= 2; i++)
    writeFileSync(
      join(dir, PASSES, "tasks-optional", `${String(i).padStart(2, "0")}-pass-a.md`),
      "opt\n",
    );
  env = { PATH: process.env["PATH"], HOME: dir, QCR_SANDBOX_ROOT: dir, QCR_PR: "7" };
  sessionsMade = 0;
  made = [];
  unhandled = [];
  process.on("unhandledRejection", onUnhandled);
  const real = rig.host.makeSession.bind(rig.host);
  vi.spyOn(rig.host, "makeSession").mockImplementation(async (spec) => {
    sessionsMade += 1;
    const s = await real(spec);
    made.push(s);
    return s;
  });
});

afterEach(async () => {
  await sleep(20);
  process.off("unhandledRejection", onUnhandled);
  vi.restoreAllMocks();
  rig.close();
  rmSync(dir, { recursive: true, force: true });
  expect(unhandled, "no unhandled rejection escaped a lens").toEqual([]);
});

const guard = (): ExtensionFactory =>
  createBashGuard({ sandboxRoot: dir, replay: false, secretDirs: [] });

const ledgerPath = (): string => join(dir, "round", "lens-ledger.jsonl");
const ledger = () => parseLedger(readFileSync(ledgerPath(), "utf8"));

function config(over: Partial<LensRunConfig> = {}): LensRunConfig {
  return {
    host: rig.host,
    permits: 6,
    registry: loadBuiltAgents(join(dir, "agents")),
    cwd: dir,
    env,
    bashGuard: guard(),
    ledgerPath: ledgerPath(),
    sessionGapMs: 0,
    ...over,
  };
}

/** A runner that counts the passes asked of it. */
function counting(runner: LensRunner): LensRunner & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    liveSessions: () => runner.liveSessions(),
    run: (request) => {
      asked.push(request.task);
      return runner.run(request);
    },
  };
}

const planned = (extra: Record<string, unknown> = {}): LaunchUnit[] => {
  const plan = planLaunch({ dirs: [`${PASSES}/tasks`], ...extra }, env);
  if (!plan.ok) throw new Error(plan.error);
  return plan.units;
};

const slowAnswers = (n: number, ms = 10): void => {
  let inFlight = 0;
  slowAnswers.peak = 0;
  rig.faux.setResponses(
    Array.from({ length: n }, () => async () => {
      slowAnswers.peak = Math.max(slowAnswers.peak, ++inFlight);
      await sleep(ms);
      inFlight--;
      return fauxAssistantMessage("found nothing");
    }),
  );
};
slowAnswers.peak = 0;

const hang = () => async (_c: TranscriptContext, options: SimpleStreamOptions | undefined) => {
  await new Promise<void>((resolve) => {
    const s = options?.signal;
    if (!s || s.aborted) return resolve();
    s.addEventListener("abort", () => resolve(), { once: true });
  });
  return fauxAssistantMessage("late");
};

function tools(runner: WaveRunner, wave: LensWave, over: Partial<LensToolDeps> = {}) {
  const [lens, lensWave] = lensToolDefinitions({ runner, wave, env, ...over });
  return { lens: lens!, lensWave: lensWave! };
}

interface Details {
  mode: string;
  results: Array<Record<string, unknown> & { id?: string; exitCode: number; agent: string }>;
  lens_wave?: {
    launched: unknown[];
    joined: unknown[];
    skipped: unknown[];
    extra_ignored?: string[];
  };
}
const detailsOf = (r: { details?: unknown }): Details => r.details as Details;

describe("[lens] the tool names (D3)", () => {
  it("are lens and lens_wave, and a consumer reads them", () => {
    const { lens, lensWave } = tools(counting(createLensRunner(config())), new LensWave());
    expect([lens.name, lensWave.name]).toEqual([LENS_TOOL, LENS_WAVE_TOOL]);
    expect([lens.name, lensWave.name]).toEqual(["lens", "lens_wave"]);
    for (const t of [lens, lensWave]) expect(isLensTool(t.name)).toBe(true);
  });

  it("are pi ToolDefinitions with the same names", () => {
    const defs = lensTools({ runner: createLensRunner(config()), wave: new LensWave(), env });
    expect(defs.map((t) => t.name)).toEqual(["lens", "lens_wave"]);
  });
});

describe("[lens_wave] a faux fan-out of 20 lenses", () => {
  it("collects the engine's wave: all 20 once, in plan order, under the cap", async () => {
    slowAnswers(20);
    const runner = counting(createLensRunner(config({ permits: 6 })));
    const wave = new LensWave();
    launchWave(wave, runner, planned());
    const updates: Array<Record<string, unknown>> = [];
    const { lensWave } = tools(runner, wave);
    const res = await lensWave.execute("w1", {}, undefined, (u: unknown) =>
      updates.push(u as Record<string, unknown>),
    );
    const d = detailsOf(res);
    expect(d.mode).toBe("parallel");
    expect(d.results).toHaveLength(20);
    expect(d.results.map((r) => r.agent)).toEqual(
      Array.from({ length: 20 }, (_, i) => ((i + 1) % 2 ? "pass-a" : "pass-b")),
    );
    expect(d.results.every((r) => r.exitCode === 0)).toBe(true);
    expect(new Set(d.results.map((r) => r.id)).size).toBe(20);
    expect(res.content[0]!.text).toMatch(/^Parallel: 20\/20 succeeded/);
    expect(runner.asked).toHaveLength(20);
    expect(sessionsMade).toBe(20);
    expect(slowAnswers.peak).toBeLessThanOrEqual(6);
    expect(ledger().filter((l) => l.kind === "lens")).toHaveLength(20);
    // Progress: it starts all-running, ends all-done, never reports an id twice in one update.
    expect(updates.length).toBe(20);
    expect((updates[0]!["details"] as Details).results.some((r) => r.exitCode === -1)).toBe(true);
    expect((updates.at(-1)!["details"] as Details).results.every((r) => r.exitCode === 0)).toBe(
      true,
    );
  });

  it("run through lens_wave({dirs}) alone, with no engine wave, it launches the 20", async () => {
    slowAnswers(20);
    const runner = counting(createLensRunner(config()));
    const wave = new LensWave();
    const res = await tools(runner, wave).lensWave.execute("w1", { dirs: [`${PASSES}/tasks`] });
    const d = detailsOf(res);
    expect(d.results).toHaveLength(20);
    expect(d.lens_wave!.launched).toHaveLength(20);
    expect(d.lens_wave!.joined).toHaveLength(0);
    expect(sessionsMade).toBe(20);
  });
});

describe("[lens_wave] the join (D8)", () => {
  it("does not relaunch a planned row and starts only the rows nobody has", async () => {
    slowAnswers(21);
    const runner = counting(createLensRunner(config()));
    const wave = new LensWave();
    const units = planned();
    // The engine launched 8 of the 20 (the others are the "not yet running" rows).
    const engineRows = launchWave(wave, runner, units.slice(0, 8));
    const { lens, lensWave } = tools(runner, wave);

    const res = await lensWave.execute("w1", { dirs: [`${PASSES}/tasks`] });
    const d = detailsOf(res);
    expect(d.results).toHaveLength(20);
    expect(d.lens_wave!.joined).toHaveLength(8);
    expect(d.lens_wave!.launched).toHaveLength(12);
    // Exactly one pass per planned row: the 8 engine rows were not asked twice.
    expect(runner.asked).toHaveLength(20);
    expect(new Set(runner.asked).size).toBe(20);
    expect(sessionsMade).toBe(20);
    // The joined rows are the engine's own runs.
    const engineIds = (await Promise.all(engineRows.map((r) => r.done))).map((r) => r.result.id);
    expect(d.results.slice(0, 8).map((r) => r.id)).toEqual(engineIds);
    expect(wave.rows().filter((r) => r.origin === "engine")).toHaveLength(8);
    expect(wave.rows().filter((r) => r.origin === "call")).toHaveLength(12);

    // An extra lens goes through `lens`: one more session, not a wave row.
    const extra = await lens.execute("l1", { agent: "pass-b", task: "look at the cache" });
    expect(detailsOf(extra).mode).toBe("single");
    expect(extra.content[0]!.text).toBe("found nothing");
    expect(sessionsMade).toBe(21);
    expect(wave.rows()).toHaveLength(20);
    expect(ledger().filter((l) => l.kind === "lens")).toHaveLength(21);
  });

  it("returns a finished wave again without running anything, with the same ids", async () => {
    slowAnswers(20, 1);
    const runner = counting(createLensRunner(config()));
    const wave = new LensWave();
    launchWave(wave, runner, planned());
    const { lensWave } = tools(runner, wave);
    const first = detailsOf(await lensWave.execute("w1", {}));
    const again = detailsOf(await lensWave.execute("w2", { dirs: [`${PASSES}/tasks`] }));
    expect(again.results.map((r) => r.id)).toEqual(first.results.map((r) => r.id));
    expect(again.lens_wave!.launched).toHaveLength(0);
    expect(again.lens_wave!.joined).toHaveLength(20);
    expect(sessionsMade).toBe(20);
    expect(runner.asked).toHaveLength(20);
  });

  it("keeps skip: a skipped row is neither joined nor launched", async () => {
    slowAnswers(10);
    const runner = counting(createLensRunner(config()));
    const wave = new LensWave();
    const d = detailsOf(
      await tools(runner, wave).lensWave.execute("w1", {
        dirs: [`${PASSES}/tasks`],
        skip: ["pass-b"],
      }),
    );
    expect(d.results).toHaveLength(10);
    expect(d.results.every((r) => r.agent === "pass-a")).toBe(true);
    expect(d.lens_wave!.skipped).toHaveLength(10);
  });

  it("applies extra to a row it starts, and says it could not to a row already running", async () => {
    slowAnswers(20);
    const runner = counting(createLensRunner(config()));
    const wave = new LensWave();
    launchWave(wave, runner, planned().slice(0, 1));
    const res = await tools(runner, wave).lensWave.execute("w1", {
      dirs: [`${PASSES}/tasks`],
      extra: { "1": "verify prior finding [F1]", "2": "verify prior finding [F2]" },
    });
    const d = detailsOf(res);
    expect(runner.asked.filter((t) => t.includes("[F2]"))).toHaveLength(1);
    expect(runner.asked.filter((t) => t.includes("[F1]"))).toHaveLength(0);
    expect(d.lens_wave!.extra_ignored).toEqual([expect.stringMatching(/01-pass-a\.md$/)]);
  });

  it("covers the optional rows through dirs, joining none of the planned ones", async () => {
    slowAnswers(22);
    const runner = counting(createLensRunner(config()));
    const wave = new LensWave();
    launchWave(wave, runner, planned());
    const d = detailsOf(
      await tools(runner, wave).lensWave.execute("w1", {
        dirs: [`${PASSES}/tasks`, `${PASSES}/tasks-optional`],
      }),
    );
    expect(d.results).toHaveLength(22);
    expect(d.lens_wave!.joined).toHaveLength(20);
    expect(d.lens_wave!.launched).toEqual([
      { phase: "optional", row: 1, agent: "pass-a" },
      { phase: "optional", row: 2, agent: "pass-a" },
    ]);
    expect(sessionsMade).toBe(22);
  });

  it("refuses with no wave and no dirs, and extra or skip without dirs", async () => {
    const runner = counting(createLensRunner(config()));
    const { lensWave } = tools(runner, new LensWave());
    const none = await lensWave.execute("w1", {});
    expect(none.isError).toBe(true);
    expect(none.content[0]!.text).toMatch(/launched no wave/);
    const named = await lensWave.execute("w2", { skip: ["1"] });
    expect(named.isError).toBe(true);
    expect(named.content[0]!.text).toMatch(/need `dirs`/);
    // The bounds are launch_plan's: a dir outside the round's is refused.
    const outside = await lensWave.execute("w3", { dirs: ["/etc"] });
    expect(outside.isError).toBe(true);
    expect(outside.content[0]!.text).toMatch(/not a round's task directory/);
    expect(runner.asked).toEqual([]);
    expect(sessionsMade).toBe(0);
  });

  it("a call that is stopped returns what landed; its own rows are forgotten, the engine's keep running", async () => {
    rig.faux.setResponses(Array.from({ length: 6 }, hang));
    const runner = counting(createLensRunner(config()));
    const wave = new LensWave();
    const engineStop = new AbortController();
    const units = planned().slice(0, 3);
    launchWave(wave, runner, units, engineStop.signal);
    const callStop = new AbortController();
    const { lensWave } = tools(runner, wave);
    const pending = lensWave.execute("w1", { dirs: [`${PASSES}/tasks-optional`] }, callStop.signal);
    await sleep(60);
    callStop.abort();
    const res = await pending;
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/stopped with \d+ lens/);
    // The call's own rows (the optional ones) are off the board; the engine's 3 are on it, running.
    await sleep(50);
    expect(wave.rows().map((r) => r.origin)).toEqual(["engine", "engine", "engine"]);
    expect(wave.running()).toBe(3);
    engineStop.abort();
    await Promise.all(wave.rows().map((r) => r.done));
  });
});

describe("[lens] single, several, and refusals", () => {
  it("runs one lens and answers its text; several at once in the order asked", async () => {
    slowAnswers(3, 1);
    const { lens } = tools(counting(createLensRunner(config())), new LensWave());
    const one = await lens.execute("l1", { agent: "pass-a", task: "t1" });
    expect(one.isError).toBeUndefined();
    expect(detailsOf(one).results[0]).toMatchObject({ agent: "pass-a", task: "t1", exitCode: 0 });
    const many = await lens.execute("l2", {
      tasks: [
        { agent: "pass-b", task: "t2" },
        { agent: "pass-a", task: "t3" },
      ],
    });
    expect(detailsOf(many).mode).toBe("parallel");
    expect(detailsOf(many).results.map((r) => r.agent)).toEqual(["pass-b", "pass-a"]);
    expect(many.content[0]!.text).toMatch(/^Parallel: 2\/2 succeeded/);
  });

  it("answers an unknown agent as a failed result, never a throw", async () => {
    const { lens } = tools(counting(createLensRunner(config())), new LensWave());
    const res = await lens.execute("l1", { agent: "pass-nope", task: "t" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/Unknown agent: "pass-nope"/);
    expect(sessionsMade).toBe(0);
  });

  it("refuses chain, both modes, an empty list and a malformed task", async () => {
    const runner = counting(createLensRunner(config()));
    const { lens } = tools(runner, new LensWave());
    for (const bad of [
      { chain: [{ agent: "pass-a", task: "x" }] },
      { agent: "pass-a", task: "x", tasks: [{ agent: "pass-a", task: "x" }] },
      { tasks: [] },
      { tasks: [{ agent: "pass-a" }] },
      { agent: "pass-a" },
      {},
    ]) {
      const res = await lens.execute("l1", bad);
      expect(res.isError, JSON.stringify(bad)).toBe(true);
    }
    expect(runner.asked).toEqual([]);
  });
});

describe("[lens] hosted as customTools on an SDK main session", () => {
  it("roundSdkExtras hands the engine's tools over as customTools and names them in the allowlist", () => {
    const lens = engineLensTools(config());
    const root = join(import.meta.dirname, "..");
    const extras = roundSdkExtras({ lens })({
      cwd: dir,
      env: { ...env, QCR_SANDBOX_ROOT: root },
    } as never);
    expect(extras.customTools?.map((t) => t.name)).toEqual(["lens", "lens_wave"]);
    expect(extras.tools).toEqual(expect.arrayContaining([...DEFAULT_TOOLS, "lens", "lens_wave"]));
    // A route with the native tool is untouched: no customTools key at all.
    const native = roundSdkExtras({ lens: { factories: [], toolNames: ["subagent"] } })({
      cwd: dir,
      env: { ...env, QCR_SANDBOX_ROOT: root },
    } as never);
    expect("customTools" in native).toBe(false);
  });

  it("the main session calls lens_wave and gets the engine's wave; its lenses carry no lens tool", async () => {
    const lens = engineLensTools(config());
    launchWave(lens.wave, lens.runner, planned().slice(0, 5));
    // main: lens_wave({dirs}) -> (the 15 not yet running + 5 joined) -> final text
    rig.faux.setResponses([
      () =>
        fauxAssistantMessage([fauxToolCall("lens_wave", { dirs: [`${PASSES}/tasks`] })], {
          stopReason: "toolUse",
        }),
      ...Array.from({ length: 20 }, () => () => fauxAssistantMessage("found nothing")),
      () => fauxAssistantMessage("all 20 lenses are in"),
    ]);
    const main = await rig.host.makeSession({
      cwd: dir,
      env,
      model: "faux/faux-1",
      customTools: lens.customTools!,
      tools: [...DEFAULT_TOOLS, ...lens.toolNames],
    });
    const lines: string[] = [];
    main.subscribe((e) => lines.push(JSON.stringify(e)));
    await main.prompt("go");
    expect(main.getLastAssistantText()).toBe("all 20 lenses are in");
    expect(main.getAllTools().map((t) => t.name)).toEqual(
      expect.arrayContaining(["lens", "lens_wave"]),
    );
    // 20 lens sessions + the main one; none of the 20 holds a lens tool.
    const lensSessions = made.filter((s) => s !== main);
    expect(lensSessions).toHaveLength(20);
    for (const s of lensSessions) {
      const names = s.getAllTools().map((t) => t.name);
      expect(names.some((n) => isLensTool(n))).toBe(false);
    }
    const end = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((e) => e["type"] === "tool_execution_end" && e["toolName"] === "lens_wave");
    const result = end!["result"] as { details: Details };
    expect(result.details.results).toHaveLength(20);
    expect(result.details.lens_wave).toMatchObject({ launched: expect.any(Array) });
    expect(result.details.lens_wave!.launched).toHaveLength(15);
    expect(result.details.lens_wave!.joined).toHaveLength(5);
    // The consumers count the 20 lenses once.
    expect(usageFromEvents(lines).children).toBe(20);
    expect(stagesFromEvents(lines).calls.map((c) => [c.agents.length, c.children])).toEqual([
      [20, 20],
    ]);
    expect(lensOutputsFromEvents(lines)).toHaveLength(20);
  });
});

describe("[lens] extensions/lens.ts in an interactive pi", () => {
  function shimEnv(): Record<string, string | undefined> {
    const agentDir = join(dir, "agentdir");
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    for (const a of ["pass-a", "pass-b"])
      writeFileSync(join(agentDir, "agents", `${a}.md`), agentFile(a));
    return {
      ...env,
      PI_CODING_AGENT_DIR: agentDir,
      QCR_SUBAGENT_MAX_CONCURRENCY: "8",
      QCR_LEDGER_FILE: join(dir, "round", "ledger.md"),
    };
  }
  const register = (factory: ExtensionFactory) => {
    const registered: Array<{ name: string; execute: (...a: never[]) => Promise<unknown> }> = [];
    void factory({ registerTool: (t: never) => registered.push(t) } as never);
    return registered as unknown as Array<{
      name: string;
      execute: (
        id: string,
        p: Record<string, unknown>,
        s?: AbortSignal,
        u?: unknown,
        c?: unknown,
      ) => Promise<{ isError?: boolean; content: Array<{ text: string }>; details?: unknown }>;
    }>;
  };

  it("registers both tools, builds its host on the first pass, and reads its cap and ledger from the env", async () => {
    const e = shimEnv();
    let hosts = 0;
    const [lens, lensWave] = register(
      interactiveLens(
        e,
        () => dir,
        async () => {
          hosts += 1;
          return rig.host;
        },
      ),
    );
    expect([lens!.name, lensWave!.name]).toEqual(["lens", "lens_wave"]);
    expect(hosts).toBe(0);
    slowAnswers(2, 1);
    const one = await lens!.execute("l1", { agent: "pass-a", task: "t" });
    expect(one.content[0]!.text).toBe("found nothing");
    await lens!.execute("l2", { agent: "pass-b", task: "t" });
    expect(hosts).toBe(1);
    // The ledger sits beside QCR_LEDGER_FILE, as the bench's cost reader finds it.
    expect(parseLedger(readFileSync(join(dir, "round", "lens-ledger.jsonl"), "utf8"))).toHaveLength(
      2,
    );
    // Nothing planned: lens_wave has no engine wave to join here.
    expect((await lensWave!.execute("w1", {})).isError).toBe(true);
    const cfg = lensRunConfigFromEnv(e, rig.host, dir);
    expect(cfg.permits).toBe(8);
    expect(cfg.registry.names()).toEqual(["pass-a", "pass-b"]);
  });

  it("a host that cannot be built fails that pass, not the pi, and is tried again", async () => {
    let hosts = 0;
    const [lens] = register(
      interactiveLens(
        shimEnv(),
        () => dir,
        async () => {
          hosts += 1;
          if (hosts === 1) throw new Error("no login");
          return rig.host;
        },
      ),
    );
    const first = await lens!.execute("l1", { agent: "pass-a", task: "t" });
    expect(first.isError).toBe(true);
    expect(first.content[0]!.text).toMatch(/no login/);
    slowAnswers(1, 1);
    const second = await lens!.execute("l2", { agent: "pass-a", task: "t" });
    expect(second.isError).toBeUndefined();
    expect(hosts).toBe(2);
  });

  it("refuses a relative agent dir", () => {
    expect(() => lensRunConfigFromEnv({ PI_CODING_AGENT_DIR: "agent" }, rig.host, dir)).toThrow(
      /absolute/,
    );
  });
});

describe("[lens] the replay: each lens counts once through the consumers", () => {
  /** A runner that answers at once with a priced result, ids L1.. */
  function priced(): WaveRunner & { n: number } {
    const self = {
      n: 0,
      run: (request: { agent: string; task: string }): Promise<LensRun> => {
        const id = `L${++self.n}`;
        return Promise.resolve({
          text: `${request.agent} found nothing`,
          result: {
            id,
            agent: request.agent,
            model: "gpt-6.1-sol:med",
            usage: { input: 1000, output: 100, cacheRead: 5000, cost: 0.01 },
            messages: [
              {
                role: "assistant",
                timestamp: 1000,
                content: [{ type: "text", text: `${request.agent} found nothing` }],
              },
            ],
            exitCode: 0,
            stopReason: "stop",
          },
        });
      },
    };
    return self;
  }

  /** The pi events one tool call leaves (start, each update, end). */
  async function callEvents(
    tool: { name: string; execute: (...a: never[]) => unknown },
    id: string,
    args: Record<string, unknown>,
  ): Promise<string[]> {
    const lines = [
      JSON.stringify({ type: "tool_execution_start", toolName: tool.name, toolCallId: id, args }),
    ];
    const exec = tool.execute as (
      id: string,
      p: Record<string, unknown>,
      s: undefined,
      u: (x: unknown) => void,
    ) => Promise<unknown>;
    const result = await exec(id, args, undefined, (partial) =>
      lines.push(
        JSON.stringify({
          type: "tool_execution_update",
          toolName: tool.name,
          toolCallId: id,
          args,
          partialResult: partial,
        }),
      ),
    );
    lines.push(
      JSON.stringify({ type: "tool_execution_end", toolName: tool.name, toolCallId: id, result }),
    );
    return lines;
  }

  it("a wave joined twice and an extra lens: cost, stages, usage and progress count each run once", async () => {
    const runner = priced();
    const wave = new LensWave();
    const units = planned().slice(0, 6);
    launchWave(wave, runner, units);
    const { lens, lensWave } = tools(runner, wave);
    const lines = [
      ...(await callEvents(lensWave, "w1", {})),
      ...(await callEvents(lens, "l1", { agent: "pass-b", task: "extra" })),
      ...(await callEvents(lensWave, "w2", {})),
    ];
    // 6 wave runs + 1 extra = 7 runs at $0.01, however often the wave is read.
    const meter = new EventCostMeter();
    for (const l of lines) meter.add(l);
    expect(meter.totalUsd).toBeCloseTo(0.07, 12);
    expect(usageFromEvents(lines).children).toBe(7);
    const stages = stagesFromEvents(lines);
    expect(stages.calls.map((c) => [c.agents.length, c.children])).toEqual([
      [6, 6],
      [1, 1],
      [0, 0],
    ]);
    expect(lensOutputsFromEvents(lines)).toHaveLength(7);
  });

  it("the ledger and the results agree: 20 lens lines for a 20-lens wave read by two calls", async () => {
    slowAnswers(20, 1);
    const runner = counting(createLensRunner(config()));
    const wave = new LensWave();
    launchWave(wave, runner, planned());
    const { lensWave } = tools(runner, wave);
    const lines = [
      ...(await callEvents(lensWave, "w1", {})),
      ...(await callEvents(lensWave, "w2", {})),
    ];
    const meter = new EventCostMeter();
    for (const l of lines) meter.add(l);
    const afterEvents = meter.totalUsd;
    for (const l of readFileSync(ledgerPath(), "utf8").split("\n")) meter.add(l);
    // Every ledger line is a run the tool results already carried.
    expect(meter.totalUsd).toBeCloseTo(afterEvents, 12);
    expect(usageFromEvents(lines).children).toBe(20);
  });
});

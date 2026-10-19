// P5.4: the engine-launched discovery wave (rule 9). The round (round.ts) starts
// the planned wave from its tasks/ before the main session's first turn, on a
// runtime that hosts the engine's lens tools (reviewsdk.ts `engine`), and the
// main session joins it through `lens_wave`. Everything here is the real pi SDK
// on pi-ai's faux provider: no model, no network.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { stagesFromEvents } from "../src/bench/aacr.js";
import { PiHost, type PiHostOptions } from "../src/engine/pisdk.js";
import {
  engineLensConfig,
  reviewSdkRuntime,
  type ReviewSdkRuntime,
} from "../src/engine/reviewsdk.js";
import { runRound, type RoundSpec } from "../src/engine/round.js";
import type { OneShotPrompts } from "../src/engine/prompts.js";
import { parseLedger } from "../src/lensresult.js";
import { pricedFaux } from "./helpers/priced-faux.js";
import {
  FILES,
  FIXTURE_CONFIG,
  OUTCOME,
  RECORD,
  TARGET,
  mkRoot,
  mkTree,
} from "./helpers/round-rig.js";
import { useOfflineGuard } from "./pi-canary/harness.js";

vi.stubEnv("QCR_CONFIG", FIXTURE_CONFIG);
const { benchConfig } = await import("../src/bench/runner.js");
const { ecosystemFor } = await import("../src/ecosystem.js");

useOfflineGuard();

const tmp = mkdtempSync(join(tmpdir(), "engine-wave-"));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const agentFile = (name: string): string =>
  `---\nname: ${name}\ndescription: ${name} lens\nmodel: faux/m\ntools: read, bash\n---\nYou are ${name}. Report findings.\n`;

/** The rows of the round's tasks/ dir: three discovery rows and the validator's. */
const ROWS = ["01-pass-a.md", "02-pass-b.md", "03-pass-c.md", "04-pass-validate.md"] as const;
const LENSES = ["pass-a", "pass-b", "pass-c", "pass-validate"] as const;

let n = 0;
let hosts: PiHost[];
beforeEach(() => {
  hosts = [];
});
afterEach(() => {
  for (const h of hosts) h.dispose();
});

interface Rig {
  rt: ReviewSdkRuntime;
  outDir: string;
  agentDir: string;
  /** What happened, in order: lens passes asked of the runner and the main
   * session's turns. */
  log: string[];
}

interface Script {
  /** The main session's turns: how long its first one takes (ms). */
  mainDelayMs?: number;
  /** A lens pass hangs until aborted (a wave nobody joins). */
  hangLenses?: boolean;
  /** The main session joins with these `lens_wave` arguments; omitted: none, but it joins. */
  join?: Record<string, unknown> | ((outDir: string) => Record<string, unknown>) | "never";
  /** Lens calls the main session makes after the join. */
  extraLens?: Array<{ agent: string; task: string }>;
}

const textOf = (m: { content?: unknown } | undefined): string => {
  const c = m?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c))
    return c.map((p) => (typeof p === "object" && p && "text" in p ? String(p.text) : "")).join("");
  return "";
};

/** A runtime over a faux provider, with the engine's lens tools, and a log. */
async function rig(over: { plannedWave: boolean }, script: Script): Promise<Rig> {
  const id = `r${n++}`;
  const dir = join(tmp, id);
  const agentDir = join(dir, "agent");
  const outDir = join(dir, "out");
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  for (const a of LENSES) writeFileSync(join(agentDir, "agents", `${a}.md`), agentFile(a));
  writeFileSync(
    join(agentDir, "auth.json"),
    JSON.stringify({
      "openai-codex": {
        type: "oauth",
        access: "a",
        refresh: "r",
        expires: Date.now() + 3 * 3_600_000,
      },
    }),
  );
  chmodSync(join(agentDir, "auth.json"), 0o600);
  const log: string[] = [];
  const faux = pricedFaux(() => 0.01, { provider: "faux", models: [{ id: "m" }] });
  const responder = async (
    context: TranscriptContext,
    options: SimpleStreamOptions | undefined,
  ) => {
    const first = textOf(context.messages.find((m) => m.role === "user") as never);
    if (first.startsWith("Task: ")) {
      log.push(
        `lens:${/(\d\d-pass-[a-z-]+\.md)/.exec(first)?.[1] ?? first.slice("Task: ".length).trim()}`,
      );
      if (script.hangLenses)
        await new Promise<void>((resolve) => {
          const s = options?.signal;
          if (!s || s.aborted) return resolve();
          s.addEventListener("abort", () => resolve(), { once: true });
        });
      else await sleep(15);
      return fauxAssistantMessage("no findings");
    }
    const results = context.messages.filter((m) => m.role === "toolResult").length;
    log.push(`main:${results}`);
    if (results === 0) {
      if (script.mainDelayMs) await sleep(script.mainDelayMs);
      if (script.join === "never") return finish();
      const args = typeof script.join === "function" ? script.join(outDir) : (script.join ?? {});
      return fauxAssistantMessage([fauxToolCall("lens_wave", args as never)], {
        stopReason: "toolUse",
      });
    }
    if (results === 1 && script.extraLens?.length)
      return fauxAssistantMessage([fauxToolCall("lens", { tasks: script.extraLens })], {
        stopReason: "toolUse",
      });
    return finish();
  };
  function finish() {
    for (const [f, text] of [
      ["findings-record.json", RECORD],
      ["outcome.json", OUTCOME],
    ] as const) {
      mkdirSync(dirname(join(outDir, f)), { recursive: true });
      writeFileSync(join(outDir, f), text);
    }
    return fauxAssistantMessage("done");
  }
  faux.appendResponses(Array.from({ length: 80 }, () => responder));
  const rt = reviewSdkRuntime({
    engine: { plannedWave: over.plannedWave },
    makeHost: async (o: PiHostOptions) => {
      const host = await PiHost.create({
        ...o,
        ownsProcess: false,
        settings: { ...o.settings, compaction: { enabled: false }, retry: { enabled: false } },
        configureModels: async (r) => {
          await o.configureModels?.(r);
          r.registerNativeProvider(faux.provider);
        },
      });
      hosts.push(host);
      return host;
    },
  });
  // What the wave's runner is asked, in order and as it happens.
  const route = rt.engineLens!;
  const inner = route.runner.run.bind(route.runner);
  route.runner.run = (request) => {
    log.push(`wave:${request.agent}`);
    return inner(request);
  };
  return { rt, outDir, agentDir, log };
}

/** The round's prompts: the order and the rows the engine wrote. */
function prompts(outDir: string): OneShotPrompts {
  return {
    system: "You are the reviewer.",
    order: "ROUND ORDER: review the PR. Launch the rows with `launch_plan`.",
    plannedLenses: ["pass-a", "pass-b", "pass-c"],
    passPlan: [],
    taskFiles: ROWS.map((f) => ({ path: join(outDir, "tasks", f), text: `task ${f}\n` })),
  };
}

async function round(r: Rig, over: Partial<RoundSpec> = {}) {
  const cfg = benchConfig("");
  cfg.models.conversation = "faux/m";
  return runRound(
    {
      root: mkRoot(tmp, `root-${n++}`),
      agentDir: r.agentDir,
      agentScope: "user",
      tree: mkTree(tmp, `tree-${n++}`),
      files: FILES,
      target: TARGET,
      outDir: r.outDir,
      cfg,
      ecosystem: ecosystemFor("none"),
      timeoutMs: 10 * 60_000,
      prompts: prompts(r.outDir),
      ...over,
    },
    r.rt,
  );
}

const eventsOf = (outDir: string): string[] =>
  readFileSync(join(outDir, "pi-events.jsonl"), "utf8").split("\n");

describe("the engine-launched wave (plannedWave)", () => {
  it("starts before the main session's first turn, never with pass-validate, and the join returns the rows in order", async () => {
    const r = await rig({ plannedWave: true }, { mainDelayMs: 250, join: {} });
    const result = await round(r);
    expect(result.error).toBeUndefined();
    expect(result.outcome).toBeDefined();

    // Three rows asked of the runner, all before the main session's first turn.
    const wave = r.log.filter((l) => l.startsWith("wave:"));
    expect(wave).toEqual(["wave:pass-a", "wave:pass-b", "wave:pass-c"]);
    expect(r.log.indexOf("main:0")).toBeGreaterThan(r.log.lastIndexOf("wave:pass-c"));
    // The validator is the session's to launch: no pass for its task file ever ran.
    expect(r.log.some((l) => l.includes("validate"))).toBe(false);

    // The session's one join held every row, in row order, each counted once.
    const stages = stagesFromEvents(eventsOf(r.outDir));
    expect(stages.calls).toHaveLength(1);
    expect(stages.calls[0]).toMatchObject({
      agents: ["pass-a", "pass-b", "pass-c"],
      kind: "lens",
      children: 3,
    });
    const ledger = parseLedger(readFileSync(join(r.outDir, "lens-ledger.jsonl"), "utf8"));
    expect(ledger.map((l) => l.agent).sort()).toEqual(["pass-a", "pass-b", "pass-c"]);
  });

  it("stagesFromEvents opens the wave at its first lens, not at the join", async () => {
    const r = await rig({ plannedWave: true }, { mainDelayMs: 300, join: {} });
    await round(r);
    const lines = eventsOf(r.outDir);
    const call = stagesFromEvents(lines).calls[0]!;
    // The main session's last message before the join is its delayed first
    // answer; the wave began (its lenses answered) well before that.
    const mainStamps = lines
      .map((l) => {
        try {
          return JSON.parse(l) as {
            type?: string;
            message?: { role?: string; timestamp?: number };
          };
        } catch {
          return {};
        }
      })
      .filter((e) => e.type === "message_end" && e.message?.role === "assistant")
      .map((e) => e.message!.timestamp!)
      .filter((t) => typeof t === "number");
    const joinedAt = Math.max(...mainStamps.slice(0, 1));
    expect(call.start_ms).not.toBeNull();
    expect(call.start_ms!).toBeLessThan(joinedAt - 100);
    expect(call.end_ms!).toBeGreaterThanOrEqual(call.start_ms!);
  });

  it("the engine section rides the order and round-order.md; the template text is the caller's, untouched", async () => {
    const r = await rig({ plannedWave: true }, { join: {} });
    const result = await round(r);
    const sent = readFileSync(join(r.outDir, "round-order.md"), "utf8");
    expect(sent).toBe(result.prompts.order);
    expect(sent.startsWith("ROUND ORDER: review the PR. Launch the rows with `launch_plan`.")).toBe(
      true,
    );
    expect(sent).toContain("## ENGINE LENS ROUTE");
    expect(sent).toContain("The engine started the planned discovery wave");
    expect(sent).toContain("3 rows: pass-a, pass-b, pass-c");
    expect(sent).not.toContain("pass-validate");
  });

  it("a row the session raises, and the validator, are its own: `lens` runs them in addition", async () => {
    const r = await rig(
      { plannedWave: true },
      {
        join: {},
        extraLens: [
          { agent: "pass-a", task: "raised version of row 1" },
          { agent: "pass-validate", task: "validate" },
        ],
      },
    );
    await round(r);
    // 3 planned rows + the raised row + the validator, each launched once.
    expect(r.log.filter((l) => l.startsWith("lens:")).sort()).toEqual([
      "lens:01-pass-a.md",
      "lens:02-pass-b.md",
      "lens:03-pass-c.md",
      "lens:raised version of row 1",
      "lens:validate",
    ]);
    const stages = stagesFromEvents(eventsOf(r.outDir));
    expect(stages.calls.map((c) => c.agents)).toEqual([
      ["pass-a", "pass-b", "pass-c"],
      ["pass-a", "pass-validate"],
    ]);
  });

  it("a wave nobody joined is ended with the round, and the round does not wait for it", async () => {
    const r = await rig({ plannedWave: true }, { hangLenses: true, join: "never" });
    const started = Date.now();
    const result = await round(r);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.error).toBeUndefined();
    expect(r.log.filter((l) => l.startsWith("wave:"))).toHaveLength(3);
    // The board holds no row still running.
    expect(r.rt.engineLens!.wave.running()).toBe(0);
    // Their passes ended aborted, each with a ledger line.
    const ledger = parseLedger(readFileSync(join(r.outDir, "lens-ledger.jsonl"), "utf8"));
    expect(ledger).toHaveLength(3);
    expect(ledger.every((l) => l.stopReason === "aborted")).toBe(true);
  });

  it("an engine route without task files starts no wave and says only the tool names", async () => {
    const r = await rig({ plannedWave: true }, { join: "never" });
    const result = await round(r, { prompts: { ...prompts(r.outDir), taskFiles: [] } });
    expect(r.log.some((l) => l.startsWith("wave:"))).toBe(false);
    expect(result.prompts.order).toContain("## ENGINE LENS ROUTE");
    expect(result.prompts.order).not.toContain("The engine started");
    expect(existsSync(join(r.outDir, "tasks"))).toBe(false);
  });
});

describe("the engine route with the session launching (engine_wave off)", () => {
  it("starts nothing at round start; lens_wave over the task dir starts the rows and joins them", async () => {
    const r = await rig(
      { plannedWave: false },
      { join: (outDir) => ({ dirs: [join(outDir, "tasks")] }) },
    );
    const result = await round(r);
    expect(result.error).toBeUndefined();
    // No row before the session's first turn; the join started the three rows.
    expect(r.log.indexOf("main:0")).toBeLessThan(r.log.indexOf("lens:01-pass-a.md"));
    expect(r.log.filter((l) => l.startsWith("lens:")).sort()).toEqual([
      "lens:01-pass-a.md",
      "lens:02-pass-b.md",
      "lens:03-pass-c.md",
    ]);
    expect(result.prompts.order).toContain(
      "Launch the planned discovery rows with ONE `lens_wave`",
    );
    expect(result.prompts.order).not.toContain("The engine started");
    const stages = stagesFromEvents(eventsOf(r.outDir));
    expect(stages.calls[0]).toMatchObject({ agents: ["pass-a", "pass-b", "pass-c"], children: 3 });
  });
});

describe("lens runner config on the review route", () => {
  it("the passes carry the reviewer stub and the main session's bash env allowlist", async () => {
    const r = await rig({ plannedWave: true }, { join: {} });
    const host = { agentDir: r.agentDir } as unknown as PiHost;
    const config = engineLensConfig(host, {
      cwd: tmp,
      env: {
        PI_CODING_AGENT_DIR: r.agentDir,
        QCR_SANDBOX_ROOT: mkRoot(tmp, `root-${n++}`),
        QCR_LEDGER_FILE: join(r.outDir, "ledger.md"),
      },
      model: "faux/m",
      eventsFile: join(tmp, "e"),
      stderrFile: join(tmp, "s"),
      limits: { timeoutMs: 1000 },
    });
    expect(config.agentsFiles?.[0]?.path).toBe(join(tmp, "AGENTS.override.md"));
    expect(config.bashEnv?.allow).toEqual(["GIT_*", "QCR_*"]);
    expect(config.ledgerPath).toBe(join(r.outDir, "lens-ledger.jsonl"));
  });
});

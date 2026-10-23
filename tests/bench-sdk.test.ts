// The bench on an SDK arm (src/engine/benchsdk.ts): the review round's main
// session and the defect judge's session as in-process SDK sessions, here over
// pi-ai's faux provider (the real SDK, no network, no model). What a case's
// session carries on each lens setting, what the judge may do, and that the
// process env a case scopes is given back.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { PiHost, type PiHostOptions } from "@quickchatai/pi-quickreview/src/engine/pisdk.js";
import { benchSdkRuntime, judgeSdkRuntime } from "../src/engine/benchsdk.js";
import { lensAgentsDir } from "@quickchatai/pi-quickreview/src/engine/lens/round-lens.js";
import {
  lensAgentsOf,
  lensSessionsOf,
  mainSessionOf,
  readOpenMeta,
} from "@quickchatai/pi-quickreview/src/engine/openable.js";
import { runRound } from "@quickchatai/pi-quickreview/src/engine/round.js";
import { sdkRuntime } from "@quickchatai/pi-quickreview/src/engine/sdkruntime.js";
import { findSession } from "../src/opencli.js";
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
const { benchConfig, judgeSessionSpec, runFingerprint, runJudgeSession } =
  await import("../src/bench/runner.js");
const { readJudgeEvents } = await import("../src/bench/defectjudge.js");
const { ecosystemFor } = await import("@quickchatai/pi-quickreview/src/ecosystem.js");

useOfflineGuard();

const tmp = mkdtempSync(join(tmpdir(), "bench-sdk-"));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

let hosts: PiHost[];
let n = 0;
beforeEach(() => {
  hosts = [];
});
afterEach(() => {
  for (const h of hosts) h.dispose();
});

const agentFile = (name: string): string =>
  `---\nname: ${name}\ndescription: ${name} lens\nmodel: faux/m\ntools: read, bash\n---\nYou are ${name}. Report findings.\n`;

/** A private agent dir holding a login, the way the bench's tmpfs one does. */
function agentDirWith(agents: string[] = []): string {
  const dir = join(tmp, `agent-${n++}`);
  mkdirSync(join(dir, "agents"), { recursive: true });
  writeFileSync(
    join(dir, "auth.json"),
    JSON.stringify({
      "openai-codex": {
        type: "oauth",
        access: "a",
        refresh: "r",
        expires: Date.now() + 3 * 3_600_000,
      },
    }),
  );
  chmodSync(join(dir, "auth.json"), 0o600);
  for (const a of agents) writeFileSync(join(dir, "agents", `${a}.md`), agentFile(a));
  return dir;
}

/** A host builder over a faux provider scripted with `responses`; `seen` hears
 * every request the model is asked. */
function fauxHost(
  responses: Array<(context: unknown) => ReturnType<typeof fauxAssistantMessage>>,
  seen: unknown[] = [],
) {
  const faux = pricedFaux(() => 0.1, { provider: "faux", models: [{ id: "m" }] });
  faux.appendResponses(
    responses.map((r) => async (context: unknown) => {
      seen.push(context);
      return r(context);
    }),
  );
  return async (o: PiHostOptions): Promise<PiHost> => {
    const host = await PiHost.create({
      ...o,
      ownsProcess: false,
      settings: { ...o.settings, compaction: { enabled: false } },
      configureModels: async (r) => {
        await o.configureModels?.(r);
        r.registerNativeProvider(faux.provider);
      },
    });
    hosts.push(host);
    return host;
  };
}

/** The tools a request declares: the faux transcript's first message lists them. */
const toolNamesIn = (context: unknown): string[] => {
  const first = (context as { messages: unknown[] }).messages[0] as {
    toolsAdded?: Array<{ name: string }>;
  };
  return (first.toolsAdded ?? []).map((t) => t.name);
};

/** One review round on the engine lens setting over a faux model that plays
 * `script`; the round's outputs are written on the main session's first turn. */
async function engineLensRound(
  script: Array<(context: unknown) => ReturnType<typeof fauxAssistantMessage>>,
  seen: unknown[],
) {
  const agentDir = agentDirWith(["pass-a"]);
  const outDir = join(tmp, `out-${n++}`);
  const write = (): void => {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "findings-record.json"), RECORD);
    writeFileSync(join(outDir, "outcome.json"), OUTCOME);
  };
  const [first, ...rest] = script;
  const runtime = benchSdkRuntime({
    makeHost: fauxHost(
      [
        (c) => {
          write();
          return first!(c);
        },
        ...rest,
      ],
      seen,
    ),
  });
  const cfg = benchConfig("");
  cfg.models.conversation = "faux/m";
  const r = await runRound(
    {
      root: mkRoot(tmp, `root-${n++}`),
      agentDir,
      agentScope: "user",
      tree: mkTree(tmp, `tree-${n++}`),
      files: FILES,
      target: TARGET,
      outDir,
      cfg,
      ecosystem: ecosystemFor("none"),
      timeoutMs: 10 * 60_000,
    },
    runtime,
  );
  return { r, outDir };
}

const callLens = (): ReturnType<typeof fauxAssistantMessage> =>
  fauxAssistantMessage([fauxToolCall("lens", { agent: "pass-a", task: "look at src/a.ts" })], {
    stopReason: "toolUse",
  });

describe("a bench review round on the SDK with the engine's lens tool", () => {
  it("runs a lens pass in this process and leaves the ledger beside the case", async () => {
    const seen: unknown[] = [];
    const { r, outDir } = await engineLensRound(
      [
        callLens,
        () => fauxAssistantMessage("pass-a found nothing"),
        () => fauxAssistantMessage("done"),
      ],
      seen,
    );
    expect(r.error).toBeUndefined();
    expect(r.outcome).toMatchObject({ verdict: "REQUEST_CHANGES" });
    // The main session has our tools and not pi's native ones.
    const main = toolNamesIn(seen[0]);
    expect(main).toEqual(expect.arrayContaining(["lens", "lens_wave"]));
    expect(main).not.toContain("subagent");
    expect(main).not.toContain("launch_plan");
    // The pass is a leaf: no lens tool of any name.
    expect(toolNamesIn(seen[1]).filter((t) => /lens|subagent|launch_plan/.test(t))).toEqual([]);
    // It ran in this process and was priced from the ledger the cost reader reads.
    const ledger = readFileSync(join(outDir, "lens-ledger.jsonl"), "utf8").trim().split("\n");
    expect(ledger).toHaveLength(1);
    expect(r.usage?.children).toBe(1);
    expect(r.costUsd).toBeGreaterThan(0.1);
  });

  it("leaves the case dir openable in pi: the main JSONL, the pass's JSONL and the record `qcr open` reads (D10)", async () => {
    const { r, outDir } = await engineLensRound(
      [
        callLens,
        () => fauxAssistantMessage("pass-a found nothing"),
        () => fauxAssistantMessage("done"),
      ],
      [],
    );
    expect(r.error).toBeUndefined();
    const main = mainSessionOf(outDir);
    expect(main).not.toBeNull();
    const kept = lensSessionsOf(outDir);
    expect(kept).toHaveLength(1);
    // the pass is named by the id and the agent its ledger line records
    expect(lensAgentsOf(outDir).get(kept[0]!.id)).toBe("pass-a");
    expect(readFileSync(kept[0]!.file, "utf8")).toContain("look at src/a.ts");
    const meta = readOpenMeta(outDir);
    expect(meta).toMatchObject({ version: 1, sessionName: "oneshot-7", env: { QCR_PR: "7" } });
    // no credential rides in it
    expect(JSON.stringify(meta)).not.toMatch(/ghp_|GITHUB_TOKEN|GH_TOKEN|API_KEY/);
    // and `qcr open` finds both from the case dir alone
    const deps = {
      detachedHome: join(tmp, "none-d"),
      runsDir: join(tmp, "none-r"),
      scanDir: join(tmp, "none-s"),
      root: tmp,
      cwd: tmp,
      env: {},
      out: () => {},
      prepare: () => {
        throw new Error("not started here");
      },
      spawn: () => 0,
    };
    expect(findSession(outDir, undefined, deps)).toMatchObject({ ok: true, file: main });
    expect(findSession(outDir, "pass-a", deps)).toMatchObject({ ok: true, id: kept[0]!.id });

    // canary 8 on the real route's file: the kept main session resumes under its own id
    const id = (JSON.parse(readFileSync(main!, "utf8").split("\n", 1)[0]!) as { id: string }).id;
    const host = await fauxHost([() => fauxAssistantMessage("resumed")])({
      agentDir: agentDirWith(),
    });
    const session = await sdkRuntime(host).resume(main!, {
      cwd: tmp,
      env: {},
      model: "faux/m",
      eventsFile: join(outDir, "resume-events.jsonl"),
      stderrFile: join(outDir, "resume-stderr.log"),
      limits: { timeoutMs: 30_000 },
    });
    expect(session.id).toBe(id);
    await session.followUp("and again");
    expect(session.sessionFile).toBe(main);
    await session.dispose();
    expect(readFileSync(main!, "utf8")).toContain("and again");
  });

  it("gives a pass's bash the git isolation pins the main session's bash has", async () => {
    const seen: unknown[] = [];
    const { r } = await engineLensRound(
      [
        callLens,
        () =>
          fauxAssistantMessage(
            [
              fauxToolCall("bash", {
                command: 'echo "pin=[$GIT_CONFIG_GLOBAL][$GIT_TERMINAL_PROMPT]"',
              }),
            ],
            { stopReason: "toolUse" },
          ),
        () => fauxAssistantMessage("pass-a found nothing"),
        () => fauxAssistantMessage("done"),
      ],
      seen,
    );
    expect(r.error).toBeUndefined();
    // The pass's second request carries its bash call's result.
    expect(JSON.stringify(seen[2])).toContain("pin=[/dev/null][0]");
  });
});

describe("a bench review round on the SDK with the engine's planned wave", () => {
  it("starts the planned wave itself, from the case's tasks/ over the bench's agents, and the main session joins it", async () => {
    const agentDir = agentDirWith(["pass-a", "pass-b"]);
    const outDir = join(tmp, `out-${n++}`);
    const seen: unknown[] = [];
    const lensWave = (): ReturnType<typeof fauxAssistantMessage> =>
      fauxAssistantMessage([fauxToolCall("lens_wave", {})], { stopReason: "toolUse" });
    const runtime = benchSdkRuntime({
      plannedWave: true,
      makeHost: fauxHost(
        [
          () => {
            mkdirSync(outDir, { recursive: true });
            writeFileSync(join(outDir, "findings-record.json"), RECORD);
            writeFileSync(join(outDir, "outcome.json"), OUTCOME);
            return lensWave();
          },
          () => fauxAssistantMessage("pass found nothing"),
          () => fauxAssistantMessage("pass found nothing"),
          () => fauxAssistantMessage("done"),
        ],
        seen,
      ),
    });
    expect((runtime as { engineLens?: { plannedWave: boolean } }).engineLens).toMatchObject({
      plannedWave: true,
    });
    const cfg = benchConfig("");
    cfg.models.conversation = "faux/m";
    const r = await runRound(
      {
        root: mkRoot(tmp, `root-${n++}`),
        agentDir,
        agentScope: "user",
        tree: mkTree(tmp, `tree-${n++}`),
        files: FILES,
        target: TARGET,
        outDir,
        cfg,
        ecosystem: ecosystemFor("none"),
        timeoutMs: 10 * 60_000,
        prompts: {
          system: "You are the reviewer.",
          order: "ROUND ORDER: review the PR.",
          plannedLenses: ["pass-a", "pass-b"],
          passPlan: [],
          taskFiles: ["01-pass-a.md", "02-pass-b.md"].map((f) => ({
            path: join(outDir, "tasks", f),
            text: `task ${f}\n`,
          })),
        },
      },
      runtime,
    );
    expect(r.error).toBeUndefined();
    expect(r.outcome).toBeDefined();
    // Both rows ran as passes of the engine's wave; the session only joined.
    const ledger = readFileSync(join(outDir, "lens-ledger.jsonl"), "utf8").trim().split("\n");
    expect(ledger).toHaveLength(2);
    expect(r.usage?.children).toBe(2);
    expect(readFileSync(join(outDir, "round-order.md"), "utf8")).toContain("lens_wave");
  });

  it("the engine setting without the wave leaves the launch to the main session", () => {
    expect(
      (benchSdkRuntime({ plannedWave: false }) as { engineLens?: unknown }).engineLens,
    ).toBeUndefined();
  });
});

describe("the bench's default config (P7.12)", () => {
  it("is the SDK runtime with the engine lens tool and the planned wave, and the fingerprint records it", () => {
    const cfg = benchConfig("");
    expect(cfg.engine.runtime).toBe("sdk");
    expect(cfg.pi.lens_runtime).toBe("engine");
    expect(cfg.pi.engine_wave).toBe(true);
    const wave = cfg.pi.lens_runtime === "engine" && cfg.pi.engine_wave;
    const sdk = runFingerprint(cfg, "", "", undefined, {
      runtime: cfg.engine.runtime,
      lens_runtime: cfg.pi.lens_runtime,
      engine_wave: wave,
    });
    expect(sdk.engine).toEqual({ runtime: "sdk", lens_runtime: "engine", wave: true });
    // a run without the wave tells itself apart from it
    const noWave = runFingerprint(cfg, "", "", undefined, {
      runtime: "sdk",
      lens_runtime: "engine",
      engine_wave: false,
    });
    expect(noWave.engine).toEqual({ runtime: "sdk", lens_runtime: "engine" });
  });
});

describe("lensAgentsDir", () => {
  it("is the agent dir's agents for the user scope and the nearest .pi/agents for the project scope", () => {
    const agentDir = agentDirWith();
    const root = join(tmp, `proj-${n++}`);
    mkdirSync(join(root, ".pi", "agents"), { recursive: true });
    mkdirSync(join(root, "deep", "er"), { recursive: true });
    const env = { PI_CODING_AGENT_DIR: agentDir };
    expect(lensAgentsDir(env, root)).toBe(join(agentDir, "agents"));
    expect(lensAgentsDir({ ...env, QCR_SUBAGENT_SCOPE: "project" }, join(root, "deep", "er"))).toBe(
      join(root, ".pi", "agents"),
    );
    expect(() =>
      lensAgentsDir({ ...env, QCR_SUBAGENT_SCOPE: "project" }, join(tmp, "nowhere")),
    ).toThrow(/no \.pi\/agents/);
    expect(() => lensAgentsDir({}, root)).toThrow(/PI_CODING_AGENT_DIR/);
  });
});

describe("the defect judge on the SDK", () => {
  it("answers through the bench's one judge session, with read and bash only and no lens tool", async () => {
    const agentDir = agentDirWith();
    const cwd = mkTree(tmp, `judge-tree-${n++}`);
    const eventsPath = join(tmp, `judge-${n++}.events.jsonl`);
    const seen: unknown[] = [];
    const runtime = judgeSdkRuntime({
      makeHost: fauxHost([() => fauxAssistantMessage('{"defects":[],"comments":[]}')], seen),
    });
    const run = await runJudgeSession("judge this", {
      root: join(import.meta.dirname, ".."),
      cwd,
      model: "faux/m",
      env: { PATH: process.env["PATH"], HOME: tmp, PI_CODING_AGENT_DIR: agentDir },
      eventsPath,
      timeoutMs: 60_000,
      runtime,
    });
    expect(run.code).toBe(0);
    expect(run.streamError).toBeNull();
    expect(readJudgeEvents(eventsPath).text).toBe('{"defects":[],"comments":[]}');
    expect(toolNamesIn(seen[0]).sort()).toEqual(["bash", "read"]);
    // The spec the proc runtime gets is the same one: the judge's tools.
    expect(
      judgeSessionSpec("/r", "m", {
        cwd,
        env: {},
        eventsFile: "",
        stderrFile: "",
        limits: { timeoutMs: 1 },
      }).tools,
    ).toEqual(["read", "bash"]);
    expect(existsSync(join(cwd, "AGENTS.override.md"))).toBe(false);
  });

  it("is told no tool beyond its allowlist: a bash call is guarded, and an unknown tool is not offered", async () => {
    const agentDir = agentDirWith();
    const cwd = mkTree(tmp, `judge-tree-${n++}`);
    const eventsPath = join(tmp, `judge-${n++}.events.jsonl`);
    const runtime = judgeSdkRuntime({
      makeHost: fauxHost([
        () =>
          fauxAssistantMessage([fauxToolCall("bash", { command: "curl -s http://example.com" })], {
            stopReason: "toolUse",
          }),
        () => fauxAssistantMessage("blocked, answering"),
      ]),
    });
    await runJudgeSession("judge this", {
      root: join(import.meta.dirname, ".."),
      cwd,
      model: "faux/m",
      env: { PATH: process.env["PATH"], HOME: tmp, PI_CODING_AGENT_DIR: agentDir },
      eventsPath,
      timeoutMs: 60_000,
      runtime,
    });
    const events = readFileSync(eventsPath, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const end = events.find((e) => e["type"] === "tool_execution_end");
    expect(end).toBeDefined();
    expect(end!["isError"]).toBe(true);
  });
});

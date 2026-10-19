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
import { PiHost, type PiHostOptions } from "../src/engine/pisdk.js";
import { benchSdkRuntime, judgeSdkRuntime } from "../src/engine/benchsdk.js";
import { lensAgentsDir } from "../src/engine/lens/round-lens.js";
import { runRound } from "../src/engine/round.js";
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
const { benchConfig, judgeSessionSpec, runJudgeSession } = await import("../src/bench/runner.js");
const { readJudgeEvents } = await import("../src/bench/defectjudge.js");
const { ecosystemFor } = await import("../src/ecosystem.js");

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

describe("a bench review round on the SDK with the engine's lens tool", () => {
  it("runs a lens pass in this process and leaves the ledger beside the case", async () => {
    const agentDir = agentDirWith(["pass-a"]);
    const outDir = join(tmp, `out-${n++}`);
    const seen: unknown[] = [];
    const write = (): void => {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, "findings-record.json"), RECORD);
      writeFileSync(join(outDir, "outcome.json"), OUTCOME);
    };
    const runtime = benchSdkRuntime({
      lens: "engine",
      makeHost: fauxHost(
        [
          () => {
            write();
            return fauxAssistantMessage(
              [fauxToolCall("lens", { agent: "pass-a", task: "look at src/a.ts" })],
              { stopReason: "toolUse" },
            );
          },
          () => fauxAssistantMessage("pass-a found nothing"),
          () => fauxAssistantMessage("done"),
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
});

describe("a bench review round on the SDK with the native lens tool", () => {
  it("scopes the case's env for the tool's children while the session lives, and gives it back", async () => {
    const agentDir = agentDirWith();
    const saved = {
      TMPDIR: process.env["TMPDIR"],
      GIT_CONFIG_GLOBAL: process.env["GIT_CONFIG_GLOBAL"],
    };
    const during: Record<string, string | undefined> = {};
    const seen: unknown[] = [];
    const runtime = benchSdkRuntime({
      lens: "native",
      makeHost: fauxHost(
        [
          () => {
            for (const k of ["TMPDIR", "GIT_CONFIG_GLOBAL"]) during[k] = process.env[k];
            return fauxAssistantMessage("done");
          },
        ],
        seen,
      ),
    });
    const session = await runtime.create({
      cwd: tmp,
      env: {
        PATH: process.env["PATH"],
        PI_CODING_AGENT_DIR: agentDir,
        QCR_SANDBOX_ROOT: join(import.meta.dirname, ".."),
        TMPDIR: "/case/tmp",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      model: "faux/m",
      eventsFile: join(tmp, `e-${n}.jsonl`),
      stderrFile: join(tmp, `s-${n++}.log`),
      limits: { timeoutMs: 60_000 },
    });
    expect((await session.prompt("go")).code).toBe(0);
    await session.dispose();
    expect(during).toEqual({ TMPDIR: "/case/tmp", GIT_CONFIG_GLOBAL: "/dev/null" });
    expect(process.env["TMPDIR"]).toBe(saved.TMPDIR);
    expect(process.env["GIT_CONFIG_GLOBAL"]).toBe(saved.GIT_CONFIG_GLOBAL);
    expect(toolNamesIn(seen[0])).toEqual(expect.arrayContaining(["subagent", "launch_plan"]));
    expect(toolNamesIn(seen[0])).not.toContain("lens");
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

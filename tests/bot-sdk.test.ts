// P8.2: the bot's SDK session factory (src/engine/botsdk.ts). What the request
// looks like against the interactive build is canary 10, bot shape
// (tests/pi-canary/canary-10-bot-request.test.ts); this file is the rest of the
// contract: the exec boundary holds through the SDK for the whole corpus, the
// model's bash gets the routing, the git pin and the memory identity and nothing
// else, rule 3 refuses a GitHub token, and the live log carries round-progress.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { lensTools } from "@quickchatai/pi-quickreview/extensions/lens.js";
import { toPiTool, textResult } from "@quickchatai/pi-quickreview/extensions/pi-tool.js";
import {
  BOT_BASH_ENV_ALLOW,
  GIT_CONFIG_PIN_NAMES,
  OPENVIKING_TOOL_NAMES,
  botSdkExtras,
  botSdkRuntime,
  refuseGithubToken,
} from "../src/engine/botsdk.js";
import { LensWave } from "@quickchatai/pi-quickreview/src/engine/lens/wave.js";
import { LENS_TOOL, LENS_WAVE_TOOL } from "@quickchatai/pi-quickreview/src/engine/lens/tool.js";
import {
  buildBashEnv,
  DEFAULT_TOOLS,
  PiHost,
} from "@quickchatai/pi-quickreview/src/engine/pisdk.js";
import type { SessionSpec } from "@quickchatai/pi-quickreview/src/engine/port.js";
import type { RoundLensTools } from "@quickchatai/pi-quickreview/src/engine/roundsdk.js";
import { REVIEWER_STUB } from "../src/hostroute.js";
import {
  liveRoundDir,
  LIVE_MAIN_FILE,
  readLiveEvents,
} from "@quickchatai/pi-quickreview/src/live/events.js";
import { roundProgressPath } from "../src/live/publish.js";
import { parseRoundProgress } from "@quickchatai/pi-quickreview/src/round-progress.js";
import { sessionGitConfigPins } from "../src/sessions.js";
import { EXEC_CORPUS } from "./helpers/exec-corpus.js";
import { useOfflineGuard } from "./pi-canary/harness.js";

useOfflineGuard();

const REPO = join(import.meta.dirname, "..");

let dir: string;
let work: string;
let hosts: PiHost[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bot-sdk-"));
  work = join(dir, "work");
  mkdirSync(work);
  // The image's layout: the stub at the tree's root, which is the bot's cwd.
  copyFileSync(join(REPO, REVIEWER_STUB), join(work, "AGENTS.override.md"));
  writeSystemPrompt();
  hosts = [];
});
afterEach(() => {
  for (const h of hosts) h.dispose();
  rmSync(dir, { recursive: true, force: true });
});

function writeSystemPrompt(): void {
  mkdirSync(join(dir, "prompts"), { recursive: true });
  copyFileSync(join(REPO, REVIEWER_STUB), join(dir, "prompts", "pr-7.md"));
}

/** The env the daemon gives a PR session, less what these cases do not read. */
function botEnv(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    PATH: process.env["PATH"],
    HOME: join(dir, "home"),
    QCR_SANDBOX_ROOT: work,
    QCR_SESSION_NAME: "pr-7",
    QCR_PR: "7",
    QCR_LEDGER_FILE: join(dir, "ledgers", "pr-7.md"),
    OPENVIKING_USER: "reviewer",
    OPENVIKING_PEER_ID: "pr-7",
    // Held by the host for other reasons and not for the model: it must not reach bash.
    OPENAI_API_KEY: "sk-not-for-the-model",
    ...sessionGitConfigPins(join(dir, "home")),
    ...over,
  };
}

function specOf(over: Partial<SessionSpec> = {}): SessionSpec {
  return {
    cwd: work,
    env: botEnv(),
    model: "faux/m",
    systemPromptFile: join(dir, "prompts", "pr-7.md"),
    eventsFile: join(dir, "events.jsonl"),
    stderrFile: join(dir, "stderr.log"),
    limits: { timeoutMs: 20_000 },
    ...over,
  };
}

/** The engine's lens tools over a runner that is never asked to run a pass. */
function lens(): RoundLensTools {
  return {
    factories: [],
    customTools: lensTools({
      runner: { run: () => Promise.reject(new Error("no pass runs here")) },
      wave: new LensWave(),
      env: {},
    }),
    toolNames: [LENS_TOOL, LENS_WAVE_TOOL],
  };
}

const postTool = defineTool(
  toPiTool({
    name: "post_review",
    label: "post_review",
    description: "Post this round's review through the daemon's gate.",
    parameters: { type: "object", properties: {} } as never,
    execute: () => textResult("posted"),
  }),
);

/** Memory off: these cases are not about a server, and the factory is still attached. */
const NO_MEMORY = (
  c: Parameters<NonNullable<Parameters<typeof botSdkExtras>[0]["openViking"]>>[0],
) => ({
  ...c,
  config: { ...c.config, enabled: false },
});

async function bot(
  responses: ReturnType<typeof fauxAssistantMessage>[],
  options: Partial<Parameters<typeof botSdkRuntime>[1]> = {},
  spec: SessionSpec = specOf(),
) {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
  faux.setResponses(responses);
  const host = await PiHost.create({
    agentDir: join(dir, "agent"),
    settings: { compaction: { enabled: false }, retry: { enabled: false } },
    configureModels: (r) => {
      r.registerNativeProvider(faux.provider);
    },
  });
  hosts.push(host);
  const runtime = botSdkRuntime(host, {
    lens: lens(),
    processEnv: {},
    openViking: NO_MEMORY,
    ...options,
  });
  return { runtime, spec, host };
}

interface Outcome {
  command: string;
  blocked: boolean;
  text: string;
}

/** Each call through the bot's session; what it answered, read off the events. */
async function replay(
  calls: readonly { tool: string; args: Record<string, unknown> }[],
  env: Record<string, string | undefined> = botEnv(),
): Promise<Outcome[]> {
  const { runtime, spec } = await bot(
    [
      ...calls.map((c) =>
        fauxAssistantMessage([fauxToolCall(c.tool, c.args as Parameters<typeof fauxToolCall>[1])], {
          stopReason: "toolUse",
        }),
      ),
      fauxAssistantMessage("done"),
    ],
    {},
    specOf({ env }),
  );
  const session = await runtime.create(spec);
  await session.prompt("go");
  await session.dispose();
  const ends = readFileSync(spec.eventsFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => e["type"] === "tool_execution_end");
  expect(ends).toHaveLength(calls.length);
  return ends.map((e, i) => ({
    command: JSON.stringify(calls[i]!.args),
    blocked: e["isError"] === true && /exec policy/.test(JSON.stringify(e["result"])),
    text: JSON.stringify(e["result"]),
  }));
}

describe("[bot SDK] the exec boundary holds through the SDK", () => {
  // Nothing external can run in these cases even if a chain were let through: the
  // model's bash finds no program, so a regression fails the case and does no harm.
  const nothingRuns = (): Record<string, string | undefined> =>
    botEnv({ PATH: join(dir, "empty-bin") });

  it("refuses every bash chain of the corpus before it runs", async () => {
    mkdirSync(join(dir, "empty-bin"));
    const chains = EXEC_CORPUS.filter((c) => c.via === "bash");
    expect(chains.length).toBeGreaterThan(50);
    const out = await replay(
      chains.map((c) => ({ tool: "bash", args: { command: c.chain } })),
      nothingRuns(),
    );
    for (const [i, o] of out.entries())
      expect(o.blocked, `round ${chains[i]!.round}: ${chains[i]!.chain}`).toBe(true);
  });

  it("refuses every write of the corpus that names a path under the tree", async () => {
    mkdirSync(join(dir, "empty-bin"));
    // An absolute path is the pure checker's (tests/exec-boundary.test.ts); a
    // refused write never reaches the disk, and these resolve inside the temp tree.
    const writes = EXEC_CORPUS.filter((c) => c.via === "write" && !c.chain.startsWith("/"));
    expect(writes.length).toBeGreaterThan(5);
    const out = await replay(
      writes.map((c) => ({ tool: "write", args: { path: c.chain, content: "x" } })),
      nothingRuns(),
    );
    for (const [i, o] of out.entries())
      expect(o.blocked, `round ${writes[i]!.round}: ${writes[i]!.chain}`).toBe(true);
    expect(existsSync(join(work, "config.toml"))).toBe(false);
  });

  it("refuses the /proc environ, mem and cmdline reads (P1.9)", async () => {
    const out = await replay(
      ["cat /proc/self/environ", "head -c 100 /proc/self/mem", "cat /proc/*/cmdline"].map(
        (command) => ({ tool: "bash", args: { command } }),
      ),
    );
    for (const o of out) expect(o.blocked, o.command).toBe(true);
  });

  it("leaves the reads that are the job open", async () => {
    const out = await replay(
      ["git --version", "ls", "cat AGENTS.override.md"].map((command) => ({
        tool: "bash",
        args: { command },
      })),
    );
    for (const o of out) expect(o.blocked, o.command).toBe(false);
    expect(out[2]!.text).toContain("session context");
  });
});

describe("[bot SDK] the model's bash environment (spawnHook)", () => {
  it("carries the git pin, the QCR_* routing and the memory identity, and no other name", async () => {
    const [printed] = await replay([{ tool: "bash", args: { command: "env" } }]);
    const lines = JSON.parse(printed!.text).content[0].text.split("\n").filter(Boolean) as string[];
    const names = lines.map((l) => l.slice(0, l.indexOf("=")));
    const pin = sessionGitConfigPins(join(dir, "home"));
    for (const [name, value] of Object.entries(pin)) expect(lines).toContain(`${name}=${value}`);
    expect(lines).toContain("QCR_SESSION_NAME=pr-7");
    expect(lines).toContain("QCR_PR=7");
    expect(lines).toContain("OPENVIKING_USER=reviewer");
    expect(lines).toContain("OPENVIKING_PEER_ID=pr-7");
    expect(lines).toContain(`HOME=${join(dir, "home")}`);
    // pi's own session identity is promised by the tool's prompt text.
    expect(names).toContain("PI_SESSION_ID");
    // The host's other names do not pass.
    expect(printed!.text).not.toContain("sk-not-for-the-model");
    for (const name of names)
      expect(
        /^(PATH|HOME|PWD|SHLVL|OLDPWD|_|LANG|GIT_.*|QCR_.*|OPENVIKING_.*|PI_.*)$/.test(name),
        name,
      ).toBe(true);
  });

  it("sets the pin explicitly, so an allowlist edit cannot drop it", () => {
    const extras = botSdkExtras({ lens: lens(), processEnv: {}, openViking: NO_MEMORY })(specOf());
    expect(extras.bashEnv?.allow).toEqual(BOT_BASH_ENV_ALLOW);
    expect(extras.bashEnv?.set).toEqual(sessionGitConfigPins(join(dir, "home")));
    // ...and the env a bash call gets holds it even from an allowlist of nothing.
    const env = buildBashEnv(
      {},
      {},
      { allow: [], ...(extras.bashEnv?.set ? { set: extras.bashEnv.set } : {}) },
    );
    expect(env["GIT_CONFIG_GLOBAL"]).toBe(join(dir, "home", ".gitconfig"));
  });

  it("names the three pin variables sessions.ts sets", () => {
    expect([...GIT_CONFIG_PIN_NAMES].sort()).toEqual(
      Object.keys(sessionGitConfigPins("/h")).sort(),
    );
  });

  it("refuses a session without the pin", () => {
    const env = botEnv({ GIT_CONFIG_GLOBAL: undefined });
    expect(() =>
      botSdkExtras({ lens: lens(), processEnv: {}, openViking: NO_MEMORY })(specOf({ env })),
    ).toThrow(/GIT_CONFIG_GLOBAL/);
  });
});

describe("[bot SDK] the session's pieces", () => {
  const extras = () =>
    botSdkExtras({
      lens: lens(),
      postTools: [postTool],
      processEnv: {},
      openViking: NO_MEMORY,
    })(specOf());

  it("customTools carry the lens tools and the post tools", () => {
    expect(extras().customTools?.map((t) => t.name)).toEqual([
      LENS_TOOL,
      LENS_WAVE_TOOL,
      "post_review",
    ]);
  });

  it("the allowlist is pi's four, the lens and post tools, the clusters and the memory tools", () => {
    expect(extras().tools).toEqual([
      ...DEFAULT_TOOLS,
      LENS_TOOL,
      LENS_WAVE_TOOL,
      "post_review",
      "cluster_findings",
      "coverage_gaps",
      ...OPENVIKING_TOOL_NAMES,
    ]);
  });

  it("loads bash-guard, ledger-pin, finding-clusters and OpenViking, in the bot's order", () => {
    expect(extras().extensions).toHaveLength(4);
  });

  it("hands the D34 reviewer stub over as data, at the cwd's context-file path", () => {
    expect(extras().agentsFiles).toEqual([
      {
        path: join(work, "AGENTS.override.md"),
        content: readFileSync(join(REPO, REVIEWER_STUB), "utf8"),
      },
    ]);
  });

  it("names the memory tools the OpenViking extension registers", () => {
    const src = readFileSync(
      join(REPO, "extensions", "vendor", "openviking-pi", "tools.ts"),
      "utf8",
    );
    const registered = [...src.matchAll(/name: "(viking_\w+)"/g)].map((m) => m[1]);
    expect([...OPENVIKING_TOOL_NAMES].sort()).toEqual([...new Set(registered)].sort());
  });

  it("is refused without the PR's system prompt, a PR name, or a pi HOME", () => {
    const build = (spec: SessionSpec) =>
      botSdkExtras({ lens: lens(), processEnv: {}, openViking: NO_MEMORY })(spec);
    const { systemPromptFile: _drop, ...bare } = specOf();
    expect(() => build(bare as SessionSpec)).toThrow(/system prompt file/);
    expect(() => build(specOf({ env: botEnv({ QCR_SESSION_NAME: "overseer" }) }))).toThrow(
      /named pr-<n>/,
    );
    expect(() => build(specOf({ env: botEnv({ HOME: undefined }) }))).toThrow(/pi HOME/);
  });
});

describe("[bot SDK] rule 3: bot mode refuses any GitHub token env", () => {
  it.each(["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN"])(
    "refuses %s in the session's env, naming the variable and never the value",
    async (name) => {
      const { runtime, spec, host } = await bot(
        [fauxAssistantMessage("never reached")],
        {},
        specOf({ env: botEnv({ [name]: "ghp_secret_value" }) }),
      );
      const failure = await runtime.create(spec).then(
        () => undefined,
        (e: Error) => e,
      );
      expect(failure?.message).toContain(name);
      expect(failure?.message).toContain("rule 3");
      expect(failure?.message).not.toContain("ghp_secret_value");
      // No session was built: the host holds nothing to dispose.
      expect((host as unknown as { sessions: Set<unknown> }).sessions.size).toBe(0);
    },
  );

  it.each(["GH_TOKEN", "GITHUB_TOKEN"])("refuses %s in the host's own env", async (name) => {
    const { runtime, spec } = await bot([fauxAssistantMessage("never reached")], {
      processEnv: { [name]: "ghp_host_secret" },
    });
    await expect(runtime.create(spec)).rejects.toThrow(new RegExp(`host env carries ${name}`));
    await expect(runtime.resume(join(dir, "x.jsonl"), spec)).rejects.toThrow(/rule 3/);
  });

  it("takes a blank value for no token", () => {
    expect(() => refuseGithubToken("the env", { GH_TOKEN: "", GITHUB_TOKEN: "  " })).not.toThrow();
    expect(() => refuseGithubToken("the env", {})).not.toThrow();
  });

  it("a token the host would have passed on never reaches the model's bash either", () => {
    // Defence in depth: the allowlist pattern cannot let one through.
    const env = buildBashEnv(
      { GITHUB_TOKEN: "ghp_x", GH_TOKEN: "ghp_y", QCR_SESSION_NAME: "pr-7" },
      {},
      { allow: BOT_BASH_ENV_ALLOW },
    );
    expect(env).toEqual({ QCR_SESSION_NAME: "pr-7" });
  });
});

describe("[bot SDK] the live log and round-progress", () => {
  it("writes the LiveEvent log and publishes round-progress v2 for the round", async () => {
    const live = { root: dir, key: "pr-7", round: 1 };
    const { runtime, spec } = await bot(
      [
        fauxAssistantMessage([fauxToolCall("bash", { command: "ls" })], { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
      ],
      { live },
    );
    const session = await runtime.create(spec);
    await session.prompt("Round 1.");
    await session.dispose();
    const log = readLiveEvents(join(liveRoundDir(dir, "pr-7", 1), LIVE_MAIN_FILE)).events;
    expect(log.map((e) => e.type)).toEqual(
      expect.arrayContaining(["session_start", "agent_start", "tool_start", "tool_end"]),
    );
    const snapshot = parseRoundProgress(readFileSync(roundProgressPath(dir, 7), "utf8"));
    expect(snapshot).toMatchObject({
      version: 2,
      pr: 7,
      session: "pr-7",
      parent_status: "settled",
    });
    const transitions = readFileSync(roundProgressPath(dir, 7).replace(/\.json$/, ".jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => (JSON.parse(l) as { event: string }).event);
    expect(transitions).toEqual(["parent_start", "parent_settle"]);
  });

  it("writes none without a live option", async () => {
    const { runtime, spec } = await bot([fauxAssistantMessage("done")]);
    const session = await runtime.create(spec);
    await session.prompt("Round 1.");
    await session.dispose();
    expect(existsSync(join(dir, "state"))).toBe(false);
  });

  it("a live log that cannot be opened never costs the round", async () => {
    // A root that is a file: the log's directory cannot be made.
    const blocked = join(dir, "not-a-dir");
    copyFileSync(join(REPO, "package.json"), blocked);
    const { runtime, spec } = await bot([fauxAssistantMessage("done")], {
      live: { root: blocked, key: "pr-7", round: 1 },
    });
    const session = await runtime.create(spec);
    const turn = await session.prompt("Round 1.");
    await session.dispose();
    expect(turn.code).toBe(0);
  });
});

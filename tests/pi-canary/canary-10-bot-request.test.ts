// Canary 10, bot shape [P8.2]: the bot worker's main session on the SDK sends the
// request the interactive build's `pi` sends.
//
// The tmux bot starts one interactive `pi` per PR, with the PR's system prompt,
// the extension files of src/sessions.ts extensionPaths (the TUI-only and bridge
// ones aside: none registers a tool or touches the prompt) and the reviewer stub
// (D34) in its cwd. This test starts that pi for real, in a pty over a local
// OpenAI-compatible endpoint (no model, nothing leaves loopback), and puts the SDK
// build (src/engine/botsdk.ts), which gets the same things as data, in front of
// the same endpoint. The raw request bodies off the wire are compared:
//
//   - the system prompt: the PR's own, then pi's, with the D34 context stub and
//     the OpenViking extension's addition
//   - the tools: pi's four, the factory-registered ones (cluster_findings,
//     coverage_gaps), the memory tools the OpenViking extension registers once it
//     has found its server, and the lens tools
//
// A process runtime cannot stand in for the interactive build here: `-p` and
// `--mode json` mark a pi as a pi-subagents leaf to the OpenViking extension
// (qcr-leaf.ts), which then adds nothing to the prompt. The bot's pi is not a leaf.
//
// The lens slot is our `lens` and `lens_wave` (D3): extensions/lens.ts in the pi
// (what the debug round and takeover load) and customTools in the session. pi's
// native `subagent` and `launch_plan` are retired with their glue.
//
// A resumed PR JSONL must keep its system prompt: a session reopened from the
// file sends the first session's prompt and tool schemas.
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { lensTools } from "../../extensions/lens.js";
import { botSdkRuntime } from "../../src/engine/botsdk.js";
import { LensWave } from "../../src/engine/lens/wave.js";
import { LENS_TOOL, LENS_WAVE_TOOL } from "../../src/engine/lens/tool.js";
import { PiHost } from "../../src/engine/pisdk.js";
import type { SessionSpec } from "../../src/engine/port.js";
import type { RoundLensTools } from "../../src/engine/roundsdk.js";
import { HOST_CONTEXT_STUB, REVIEWER_STUB } from "../../src/hostroute.js";
import { openVikingSessionEnv } from "../../src/memory/ovsession.js";
import { sessionGitConfigPins } from "../../src/sessions.js";
import {
  FAKE_MODEL,
  startFakeOpenAI,
  writeFakeProvider,
  type FakeOpenAI,
} from "../helpers/fake-openai.js";
import { mkRoot } from "../helpers/round-rig.js";
import { useOfflineGuard } from "./harness.js";

useOfflineGuard({ loopback: true });

const ROOT = resolve(import.meta.dirname, "..", "..");
const PI_BIN = join(ROOT, "node_modules", ".bin", "pi");
const SESSION = "pr-7";
const hasScript = spawnSync("script", ["--version"], { encoding: "utf8" }).status === 0;
const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

let server: FakeOpenAI;
/** An OpenViking that answers every call with an empty success: the extension
 * finds the server healthy, attaches to the daemon's session and registers its
 * memory tools in the middle of the first prompt, as it does in production. Both
 * builds meet the same answers. */
let memory: Server;
let memoryUrl: string;
beforeAll(async () => {
  server = await startFakeOpenAI();
  memory = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", result: {} }));
    });
  });
  await new Promise<void>((done) => memory.listen(0, "127.0.0.1", done));
  memoryUrl = `http://127.0.0.1:${(memory.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await server.close();
  await new Promise((done) => memory.close(done));
});

let dir: string;
let root: string;
let hosts: PiHost[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-canary-10-bot-"));
  root = mkRoot(dir, "root");
  hosts = [];
  server.requests.length = 0;
  mkdirSync(join(dir, "home"));
  writeFakeProvider(join(dir, "agent-cli"), server.baseUrl);
  writeFakeProvider(join(dir, "agent-sdk"), server.baseUrl);
  writeFileSync(
    join(dir, "system.md"),
    "You are the reviewer of PR 7.\nOne session owns this PR's whole review.\n",
  );
  // The reviewer stub where pi looks for a context file: the sandbox root, which
  // is the bot's cwd. The SDK session is handed it as data at the same path.
  mkdirSync(join(dir, "work"));
  copyFileSync(join(ROOT, REVIEWER_STUB), join(dir, "work", HOST_CONTEXT_STUB));
});
afterEach(() => {
  for (const h of hosts) h.dispose();
  rmSync(dir, { recursive: true, force: true });
});

/** The env the daemon builds for a PR session (PiSessionManager.buildEnv), less
 * what no request depends on. */
function botEnv(): Record<string, string> {
  const home = join(dir, "home");
  return {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: home,
    LANG: "C.UTF-8",
    // The lens tool's description names the agent dir it reads from: the
    // child's PI_CODING_AGENT_DIR, the host process's env on the SDK route. One
    // path for both, so the comparison is of the build and not of a directory.
    PI_CODING_AGENT_DIR: join(dir, "agent-cli"),
    QCR_SANDBOX_ROOT: root,
    QCR_SESSION_NAME: SESSION,
    QCR_PR: "7",
    QCR_LEDGER_FILE: join(dir, "ledgers", `${SESSION}.md`),
    QCR_SUBAGENT_MAX_CONCURRENCY: "4",
    QCR_SUBAGENT_CACHE_GROUP: "0",
    QCR_SUBAGENT_PASS_DEADLINE_MIN: "0",
    ...sessionGitConfigPins(home),
    ...openVikingSessionEnv({
      baseUrl: memoryUrl,
      user: "reviewer",
      peerId: SESSION,
      cliConfigPath: join(dir, "no-ovcli.conf"),
      ovSessionId: SESSION,
    }),
    OPENVIKING_CREDENTIAL_SOURCE: "env",
    OPENVIKING_API_KEY: "k-canary",
    OV_DEBUG_LOG: join(dir, "ov-debug.log"),
    OPENVIKING_CONFIG_FILE: join(dir, "no-ov.conf"),
  };
}

/** The extension files the tmux bot loads, in its order, with the lens slot's. */
function botExtensions(): string[] {
  const ext = (name: string): string => join(root, "extensions", name);
  return [
    ext("bash-guard.ts"),
    ext("ledger-pin.ts"),
    ext("lens.ts"),
    ext("finding-clusters.ts"),
    ext(join("vendor", "openviking-pi", "index.ts")),
  ];
}

/** The engine's lens tools over a runner that is never asked to run a pass. */
function engineLens(env: Record<string, string>): RoundLensTools {
  return {
    factories: [],
    customTools: lensTools({
      runner: { run: () => Promise.reject(new Error("no pass runs in this canary")) },
      wave: new LensWave(),
      env,
    }),
    toolNames: [LENS_TOOL, LENS_WAVE_TOOL],
  };
}

function specFor(name: string, over: Partial<SessionSpec> = {}): SessionSpec {
  return {
    cwd: join(dir, "work"),
    env: botEnv(),
    model: FAKE_MODEL,
    systemPromptFile: join(dir, "system.md"),
    name: SESSION,
    eventsFile: join(dir, `${name}-events.jsonl`),
    stderrFile: join(dir, `${name}-stderr.log`),
    limits: { timeoutMs: 10 * 60_000 },
    ...over,
  };
}

interface Request {
  body: string;
}

interface Run {
  requests: Request[];
  id: string;
  file: string | null;
}

/** The first request of the interactive build: the real `pi`, started the way the
 * tmux bot starts it (src/sessions.ts buildPiCommand: no discovery switch), given
 * the first message as its argument, in a pty. */
async function interactive(): Promise<Run> {
  server.script([{ text: "ok" }]);
  const before = server.requests.length;
  const sessions = join(dir, "sessions-pi");
  mkdirSync(sessions);
  const argv = [
    PI_BIN,
    "--approve",
    "--model",
    FAKE_MODEL,
    "--session-dir",
    sessions,
    "--system-prompt",
    join(dir, "system.md"),
    ...botExtensions().flatMap((e) => ["--extension", e]),
    "--name",
    SESSION,
    "Review PR 7.",
  ];
  writeFileSync(join(dir, "agent-cli", "auth.json"), "{}\n", { mode: 0o600 });
  await new Promise<void>((done) => {
    const line = `stty cols 140 rows 50; exec ${argv.map(q).join(" ")}`;
    const child = spawn("script", ["-qefc", line, "/dev/null"], {
      cwd: join(dir, "work"),
      env: { ...botEnv(), PI_OFFLINE: "1", PI_TELEMETRY: "0", TERM: "xterm-256color" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.resume();
    const t0 = Date.now();
    const poll = setInterval(() => {
      // The turn is over when the session file holds the model's answer.
      const answered = readdirSync(sessions).some((f) =>
        readFileSync(join(sessions, f), "utf8").includes('"role":"assistant"'),
      );
      if ((server.requests.length > before && answered) || Date.now() - t0 > 45_000) {
        clearInterval(poll);
        // ^D on an empty editor: the person leaves pi
        child.stdin.write("\x04");
        setTimeout(() => child.kill("SIGKILL"), 10_000);
      }
    }, 250);
    child.on("close", () => {
      clearInterval(poll);
      done();
    });
  });
  const requests = server.requests.slice(before);
  expect(requests, "the interactive pi sent one request").toHaveLength(1);
  const [file] = readdirSync(sessions);
  const header = JSON.parse(readFileSync(join(sessions, file!), "utf8").split("\n", 1)[0]!) as {
    id: string;
  };
  return { requests, id: header.id, file: join(sessions, file!) };
}

/** The bot worker's session on the SDK: a first turn and a second one. */
async function worker(): Promise<Run> {
  server.script([{ text: "ok" }, { text: "ok" }]);
  const before = server.requests.length;
  const spec = specFor("sdk", { sessionDir: join(dir, "sessions-sdk") });
  const env = spec.env as Record<string, string>;
  const host = await PiHost.create({ agentDir: join(dir, "agent-sdk") });
  hosts.push(host);
  const session = await botSdkRuntime(host, {
    lens: engineLens(env),
    processEnv: {},
  }).create(spec);
  const first = await session.prompt("Review PR 7.");
  expect(first.code, first.streamError ?? "").toBe(0);
  expect((await session.followUp("Anything left?")).status).toBe("handled");
  const run = { id: session.id, file: session.sessionFile };
  await session.dispose();
  const requests = server.requests.slice(before);
  expect(requests).toHaveLength(2);
  return { requests, ...run };
}

const masked = (body: string, id: string): string => body.split(id).join("<session-id>");

interface Body {
  messages: { role: string; content: unknown }[];
  tools: { function: { name: string } }[];
}

/** The two requests are the same bytes. Taken apart first, so that a difference
 * reads as "the system prompt" or "the tool X" and not as two long strings. */
function expectSameRequest(sdk: { body: string; id: string }, pi: { body: string; id: string }) {
  const a = JSON.parse(masked(pi.body, pi.id)) as Body;
  const b = JSON.parse(masked(sdk.body, sdk.id)) as Body;
  expect(b.messages[0], "the system prompt").toEqual(a.messages[0]);
  expect(
    b.tools.map((t) => t.function.name),
    "the tools, in order",
  ).toEqual(a.tools.map((t) => t.function.name));
  for (const [i, tool] of a.tools.entries()) expect(b.tools[i], tool.function.name).toEqual(tool);
  expect(masked(sdk.body, sdk.id)).toBe(masked(pi.body, pi.id));
}

const toolNames = (body: string): string[] =>
  (JSON.parse(body) as Body).tools.map((t) => t.function.name);

describe.skipIf(!hasScript || process.platform !== "linux")(
  "[canary 10, bot] the SDK request == the interactive build's, with the engine's lens tools",
  () => {
    it(
      "system prompt, D34 context stub, factory tools, memory tools, lens tools: the first request",
      { timeout: 120_000 },
      async () => {
        const pi = await interactive();
        const sdk = await worker();
        const a = pi.requests[0]!.body;
        const system = (JSON.parse(a) as Body).messages[0]!.content as string;
        // The comparison is not vacuous.
        expect(system).toContain("You are the reviewer of PR 7.");
        expect(system).toContain("AGENTS.override.md");
        expect(system).toContain("OpenViking tools: viking_search");
        const wanted = [LENS_TOOL, LENS_WAVE_TOOL];
        for (const tool of [
          "bash",
          ...wanted,
          "cluster_findings",
          "coverage_gaps",
          "viking_search",
          "viking_read",
        ])
          expect(toolNames(a), tool).toContain(tool);
        expectSameRequest({ body: sdk.requests[0]!.body, id: sdk.id }, { body: a, id: pi.id });
      },
    );
  },
);

describe("[canary 10, bot] the SDK session across turns and across a resume", () => {
  it(
    "the second turn extends the first: same system prompt, same tools, the history after it",
    { timeout: 60_000 },
    async () => {
      const sdk = await worker();
      const [one, two] = sdk.requests.map((r) => JSON.parse(masked(r.body, sdk.id)) as Body);
      expect(two!.messages[0]).toEqual(one!.messages[0]);
      expect(two!.tools).toEqual(one!.tools);
      expect(two!.messages.slice(1, 2)).toEqual(one!.messages.slice(1, 2));
      expect(two!.messages).toHaveLength(one!.messages.length + 2);
    },
  );

  it(
    "a reopened PR JSONL sends the first session's prompt, stub and tool schemas, under its id",
    { timeout: 60_000 },
    async () => {
      const first = await worker();
      expect(first.file).not.toBeNull();
      // A new worker: a new host and a new factory over the PR's newest JSONL.
      server.script([{ text: "ok" }]);
      const before = server.requests.length;
      const spec = specFor("sdk-resumed");
      const host = await PiHost.create({ agentDir: join(dir, "agent-sdk") });
      hosts.push(host);
      const session = await botSdkRuntime(host, {
        lens: engineLens(spec.env as Record<string, string>),
        processEnv: {},
      }).resume(first.file!, spec);
      expect(session.id).toBe(first.id);
      expect((await session.followUp("Round 2: the head moved.")).status).toBe("handled");
      await session.dispose();
      const resumed = server.requests.slice(before);
      expect(resumed).toHaveLength(1);
      const shape = (body: string): { system: unknown; tools: unknown } => {
        const parsed = JSON.parse(masked(body, first.id)) as Body;
        return { system: parsed.messages[0], tools: parsed.tools };
      };
      // The request is compared to the first session's LAST turn: the prompt cache
      // is keyed on this prefix, and the memory tools were already registered then.
      expect(shape(resumed[0]!.body)).toEqual(shape(first.requests[1]!.body));
      expect(JSON.stringify(shape(resumed[0]!.body).system)).toContain("AGENTS.override.md");
    },
  );
});

// P2.9: sdkRuntime, the runtime port hosted in-process on the pi SDK. The shared
// port contract runs on it over pi-ai's faux provider (the real SDK, no model, no
// network); what only a live, file-backed session has is tested after it, under
// the runtime's own name. The wire parity with a real `pi` CLI child, on a local
// OpenAI-compatible endpoint, is the last group.
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { stagesFromEvents, usageFromEvents } from "../src/bench/aacr.js";
import { PiHost } from "../src/engine/pisdk.js";
import {
  RuntimeUnsupportedError,
  type Runtime,
  type SessionEvent,
  type SessionSpec,
} from "../src/engine/port.js";
import { procRuntime } from "../src/engine/procruntime.js";
import { sdkRuntime } from "../src/engine/sdkruntime.js";
import { useOfflineGuard } from "./pi-canary/harness.js";
import {
  startFakeOpenAI,
  writeFakeProvider,
  FAKE_MODEL,
  type FakeOpenAI,
} from "./helpers/fake-openai.js";
import {
  pollUntil,
  portContract,
  type Behaviour,
  type PortHarness,
} from "./helpers/port-contract.js";
import { pricedFaux } from "./helpers/priced-faux.js";

useOfflineGuard({ loopback: true });

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The text of the user message a request ends with; null when it ends with
 * anything else (a tool result: the turn is still working). */
function lastUserText(context: TranscriptContext): string | null {
  const m = context.messages[context.messages.length - 1] as
    { role: string; content: string | { type: string; text?: string }[] } | undefined;
  if (m?.role !== "user") return null;
  return typeof m.content === "string"
    ? m.content
    : m.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

const hosts = new Map<string, PiHost>();
const delivered = new Map<string, string[]>();

/** A runtime on a faux provider that plays `behaviour` for every request. The
 * host is built when the first session is asked for (the port's `runtime` is
 * synchronous; PiHost.create is not). */
function fauxRuntime(dir: string, behaviour: Behaviour): Runtime {
  let built: Promise<Runtime> | undefined;
  const build = (): Promise<Runtime> =>
    (built ??= (async () => {
      // A text reply costs 0.75, a tool-calling one 0.45 (see Behaviour).
      const faux = pricedFaux((m) => (m.content.some((c) => c.type === "toolCall") ? 0.45 : 0.75), {
        provider: "faux",
        models: [{ id: "m" }],
      });
      delivered.set(dir, []);
      const reply = async (
        context: TranscriptContext,
        options: { signal?: AbortSignal } | undefined,
      ) => {
        const text = lastUserText(context);
        if (text !== null) delivered.get(dir)!.push(text);
        switch (behaviour) {
          case "stream":
            return fauxAssistantMessage("x".repeat(40));
          case "slow":
            await sleep(500);
            return fauxAssistantMessage("done");
          case "hang":
            await new Promise<void>((resolve) => {
              const signal = options?.signal;
              if (!signal || signal.aborted) return resolve();
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
            return fauxAssistantMessage("late");
          case "spendy":
            return fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 0.3" })], {
              stopReason: "toolUse",
            });
          case "separators":
            return fauxAssistantMessage(`a${LS}b${PS}c`);
          default:
            return fauxAssistantMessage("ok");
        }
      };
      faux.appendResponses(Array.from({ length: 40 }, () => reply));
      const host = await PiHost.create({
        agentDir: join(dir, "agent"),
        settings: { compaction: { enabled: false }, retry: { enabled: false } },
        configureModels: (r) => {
          r.registerNativeProvider(faux.provider);
        },
      });
      hosts.set(dir, host);
      return sdkRuntime(host);
    })());
  return {
    create: async (spec) => (await build()).create(spec),
    resume: async (file, spec) => (await build()).resume(file, spec),
  };
}

const sdk: PortHarness = {
  name: "sdkRuntime",
  model: "faux/m",
  steer: "delivered",
  resume: "supported",
  agentsFiles: "supported",
  recordedStream: false,
  runtime: fauxRuntime,
  delivered: (dir) => delivered.get(dir) ?? [],
  cleanup: (dir) => {
    hosts.get(dir)?.dispose();
    hosts.delete(dir);
    delivered.delete(dir);
  },
};

portContract(sdk);

describe("[sdkRuntime] what is its own", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sdk-runtime-"));
  });
  afterEach(async () => {
    await sdk.cleanup?.(dir);
    rmSync(dir, { recursive: true, force: true });
  });

  const spec = (over: Partial<SessionSpec> = {}): SessionSpec => ({
    cwd: dir,
    env: { PATH: process.env["PATH"] },
    model: "faux/m",
    eventsFile: join(dir, "events.jsonl"),
    stderrFile: join(dir, "stderr.log"),
    limits: { timeoutMs: 20_000 },
    ...over,
  });
  const open = (b: Behaviour, over: Partial<SessionSpec> = {}) =>
    sdk.runtime(dir, b).create(spec(over));
  const lines = (file: string): Record<string, unknown>[] =>
    readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);

  describe("the events file", () => {
    it("opens with the session header and holds the stream a pi child prints, less its updates", async () => {
      const s = await open("spendy", { limits: { timeoutMs: 20_000, capUsd: 0.5 } });
      await s.prompt("go");
      await s.dispose();
      const events = lines(join(dir, "events.jsonl"));
      expect(events[0]).toMatchObject({ type: "session", version: 3, id: s.id });
      const types = new Set(events.map((e) => e["type"]));
      for (const t of ["agent_start", "turn_start", "message_end", "tool_execution_end"])
        expect(types, t).toContain(t);
      expect(types).not.toContain("message_update");
      expect(types).not.toContain("tool_execution_update");
    });

    it("writes the header once for the session, not once per turn", async () => {
      const s = await open("echo");
      await s.prompt("one");
      await s.followUp("two");
      await s.dispose();
      expect(lines(join(dir, "events.jsonl")).filter((e) => e["type"] === "session")).toHaveLength(
        1,
      );
    });

    it("exists from the start, empty, as the files of a spawned pi do", async () => {
      const s = await open("echo");
      expect(readFileSync(join(dir, "events.jsonl"), "utf8")).toBe("");
      expect(readFileSync(join(dir, "stderr.log"), "utf8")).toBe("");
      await s.dispose();
    });
  });

  describe("the session file", () => {
    it("is null with no file in the spec, and the exact path once the session has a user message", async () => {
      const file = join(dir, "run", "main.jsonl");
      const s = await open("echo", { sessionFile: file });
      // pi writes the file from the first user message on; before that there is none.
      expect(s.sessionFile).toBeNull();
      await s.prompt("review");
      expect(s.sessionFile).toBe(file);
      const [header, ...rest] = lines(file);
      expect(header).toMatchObject({ type: "session", version: 3, id: s.id, cwd: dir });
      expect(rest.some((e) => e["type"] === "message")).toBe(true);
      await s.dispose();
    });

    it("under a sessionDir pi names the file, and the session reports it", async () => {
      const sessionDir = join(dir, "sessions");
      const s = await open("echo", { sessionDir });
      await s.prompt("review");
      expect(s.sessionFile).toMatch(new RegExp(`^${sessionDir}/.*${s.id}\\.jsonl$`));
      await s.dispose();
    });

    it("keeps appending to the same file across follow-ups", async () => {
      const file = join(dir, "main.jsonl");
      const s = await open("echo", { sessionFile: file });
      await s.prompt("one");
      const after1 = lines(file).length;
      await s.followUp("two");
      await s.dispose();
      const all = lines(file);
      expect(all.length).toBeGreaterThan(after1);
      expect(all.filter((e) => e["type"] === "session")).toHaveLength(1);
    });

    it("refuses a file and a directory together, a relative path, and a file that exists", async () => {
      await expect(
        open("echo", { sessionFile: join(dir, "a.jsonl"), sessionDir: dir }),
      ).rejects.toThrow(/not both/);
      await expect(open("echo", { sessionFile: "relative.jsonl" })).rejects.toThrow(/absolute/);
      const old = join(dir, "old.jsonl");
      writeFileSync(old, "{}\n");
      await expect(open("echo", { sessionFile: old })).rejects.toThrow(/already exists/);
      expect(readFileSync(old, "utf8")).toBe("{}\n");
    });
  });

  describe("resume of a file interactive pi wrote", () => {
    const FIXTURE = join(import.meta.dirname, "pi-canary", "fixtures", "interactive-v3.jsonl");
    const FIXTURE_ID = "0192a3c4-5d6e-7f80-9a1b-2c3d4e5f6a7b";

    it("keeps its id and its history, and the new turn lands in the same file", async () => {
      const sessions = join(dir, "sessions");
      mkdirSync(sessions);
      const file = join(sessions, `2026-10-12T09-00-00-000Z_${FIXTURE_ID}.jsonl`);
      copyFileSync(FIXTURE, file);
      const original = lines(file);
      const s = await sdk.runtime(dir, "echo").resume(file, spec());
      expect(s.id).toBe(FIXTURE_ID);
      expect(s.sessionFile).toBe(file);
      expect((await s.prompt("Round 3.")).code).toBe(0);
      await s.dispose();
      const after = lines(file);
      expect(after.slice(0, original.length)).toEqual(original);
      expect(after.length).toBeGreaterThan(original.length);
      expect(JSON.stringify(after.slice(original.length))).toContain("Round 3.");
      expect(readdirSync(sessions)).toHaveLength(1);
      // The events file opens with the resumed session's own header.
      expect(lines(join(dir, "events.jsonl"))[0]).toMatchObject({
        type: "session",
        id: FIXTURE_ID,
      });
    });
  });

  describe("the CLI spellings it keeps", () => {
    it("trims the first prompt as pi's piped stdin does, and sends a follow-up as written", async () => {
      const s = await open("echo");
      await s.prompt("\n  round order \n\n");
      await s.followUp("  continue \n");
      await s.dispose();
      expect(sdk.delivered(dir)).toEqual(["round order", "  continue \n"]);
    });

    it("takes `provider/id:level` as the model, as --model does", async () => {
      const s = await open("echo", { model: "faux/m:high" });
      expect((await s.prompt("go")).code).toBe(0);
      await s.dispose();
    });
  });

  describe("steer", () => {
    it("reaches the turn in flight: the model's next request carries it", async () => {
      const s = await open("slow");
      const turn = s.prompt("first");
      await pollUntil(() => sdk.delivered(dir).length === 1, "the turn to start");
      expect(await s.steer("change course")).toEqual({ status: "queued" });
      const r = await turn;
      expect(r.code).toBe(0);
      expect(sdk.delivered(dir)).toEqual(["first", "change course"]);
      await s.dispose();
    });

    it("on an idle session starts a turn with the message", async () => {
      const s = await open("echo");
      await s.prompt("first");
      expect(await s.steer("again")).toMatchObject({ status: "handled", result: { code: 0 } });
      expect(sdk.delivered(dir)).toEqual(["first", "again"]);
      await s.dispose();
    });
  });

  describe("what it refuses", () => {
    it("extension paths: an SDK session loads factories", async () => {
      await expect(open("echo", { extensions: ["/x/ext.ts"] })).rejects.toBeInstanceOf(
        RuntimeUnsupportedError,
      );
    });

    it("a host session given both a manager and a persist target", async () => {
      const host = await PiHost.create({ agentDir: join(dir, "agent") });
      await expect(
        host.makeSession({
          cwd: dir,
          env: {},
          model: "none/none",
          persist: { sessionDir: dir },
          sessionManager: {} as never,
        }),
      ).rejects.toThrow(/not both/);
      host.dispose();
    });

    it("a second prompt: the session continues by followUp", async () => {
      const s = await open("echo");
      await s.prompt("one");
      await expect(s.prompt("two")).rejects.toBeInstanceOf(RuntimeUnsupportedError);
      await s.dispose();
    });

    it("a route's extras hook is asked for the spec's extensions", async () => {
      const host = hosts.get(dir) ?? (await PiHost.create({ agentDir: join(dir, "agent") }));
      const seen: string[] = [];
      const rt = sdkRuntime(host, {
        extras: (sp) => {
          seen.push(...(sp.extensions ?? []));
          return {};
        },
      });
      await expect(
        rt.create(spec({ extensions: ["/x/ext.ts"], model: "none/none" })),
      ).rejects.toThrow(/not known/);
      expect(seen).toEqual(["/x/ext.ts"]);
      host.dispose();
    });
  });
});

// ---- the real pi CLI on the same endpoint ---------------------------------------

const ROOT = resolve(import.meta.dirname, "..");
const PI_BIN = join(ROOT, "node_modules", ".bin", "pi");

describe("[sdkRuntime] against a real pi CLI on a local endpoint", () => {
  let server: FakeOpenAI;
  beforeAll(async () => {
    server = await startFakeOpenAI();
  });
  afterAll(() => server.close());

  let dir: string;
  let host: PiHost;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "sdk-runtime-cli-"));
    server.requests.length = 0;
    mkdirSync(join(dir, "work"));
    writeFakeProvider(join(dir, "agent-cli"), server.baseUrl);
    writeFakeProvider(join(dir, "agent-sdk"), server.baseUrl);
    host = await PiHost.create({ agentDir: join(dir, "agent-sdk") });
  });
  afterEach(() => {
    host.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  const spec = (name: string, over: Partial<SessionSpec> = {}): SessionSpec => ({
    cwd: join(dir, "work"),
    env: {
      PATH: process.env["PATH"],
      HOME: join(dir, "home"),
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      PI_CODING_AGENT_DIR: join(dir, "agent-cli"),
    },
    model: FAKE_MODEL,
    eventsFile: join(dir, `${name}-events.jsonl`),
    stderrFile: join(dir, `${name}-stderr.log`),
    limits: { timeoutMs: 60_000 },
    ...over,
  });
  const CLI_FLAGS = ["-ne", "-ns", "-np", "--no-themes"];
  const jsonl = (file: string): string[] => readFileSync(file, "utf8").split("\n").filter(Boolean);

  it("leaves a v3 JSONL at sessionFile that a CLI pi --session opens with the same id", async () => {
    server.script([{ text: "first answer" }, { text: "second answer" }]);
    const file = join(dir, "run", "main.jsonl");
    const s = await sdkRuntime(host).create(spec("sdk", { sessionFile: file }));
    expect((await s.prompt("round one")).code).toBe(0);
    await s.dispose();
    const before = jsonl(file);
    expect(JSON.parse(before[0]!)).toMatchObject({ type: "session", version: 3, id: s.id });

    const cli = await procRuntime({ bin: PI_BIN }).create(
      spec("cli", { cliFlags: [...CLI_FLAGS, "--session", file] }),
    );
    const r = await cli.prompt("round two");
    await cli.dispose();
    expect(r.code, readFileSync(join(dir, "cli-stderr.log"), "utf8")).toBe(0);

    // The CLI announced the SDK's session id, carried the SDK's turn into its
    // request, and appended to the same file under the same header.
    expect(JSON.parse(jsonl(join(dir, "cli-events.jsonl"))[0]!)).toMatchObject({
      type: "session",
      id: s.id,
    });
    const request = server.requests[1]!.body;
    expect(request).toContain("round one");
    expect(request).toContain("first answer");
    const after = jsonl(file);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.length).toBeGreaterThan(before.length);
    expect(after.filter((l) => JSON.parse(l).type === "session")).toHaveLength(1);
  });

  it("the aacr parsers read an SDK events file the way they read a CLI one", async () => {
    const script = [
      {
        text: "looking",
        toolCalls: [{ id: "call_1", name: "bash", args: { command: "echo hi" } }],
        usage: { prompt: 100, completion: 10 },
      },
      { text: "all done", usage: { prompt: 150, completion: 20 } },
    ];
    const run = async (kind: "cli" | "sdk") => {
      server.script(script);
      const s = await (kind === "cli"
        ? procRuntime({ bin: PI_BIN }).create(spec(kind, { cliFlags: CLI_FLAGS }))
        : sdkRuntime(host).create(spec(kind)));
      const heard: SessionEvent[] = [];
      s.subscribe((e) => heard.push(e));
      expect((await s.prompt("go")).code).toBe(0);
      await s.dispose();
      expect(heard.length).toBeGreaterThan(0);
      return jsonl(spec(kind).eventsFile);
    };
    const cli = await run("cli");
    const sdkLines = await run("sdk");

    expect(usageFromEvents(cli).input).toBe(250);
    expect(usageFromEvents(sdkLines)).toEqual(usageFromEvents(cli));
    expect(stagesFromEvents(sdkLines)).toEqual(stagesFromEvents(cli));
    // The same events in the same order, as far as their type goes.
    const types = (lines: string[]): string[] => lines.map((l) => String(JSON.parse(l).type));
    expect(types(sdkLines)).toEqual(types(cli));
    // And the same shape under each type (keys, not the run's own values).
    const shape = (lines: string[]): string[] =>
      [...new Set(lines.map((l) => Object.keys(JSON.parse(l)).sort().join(",")))].sort();
    expect(shape(sdkLines)).toEqual(shape(cli));
  });
});

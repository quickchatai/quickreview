// [P5.7] Scan leaves on the SDK: sdkCaseRunner (src/engine/caserunner-sdk.ts),
// SetupEngine's CaseRunner over the runtime port, and the wiring that picks it
// in scancli's driver and never in the companion's pi.
//
// No model is called. Failure and abort paths run on pi-ai's faux provider; the
// parity group runs the REAL pi (the SDK in this process and a `pi` CLI child)
// in front of one local OpenAI-compatible endpoint and compares what each
// sent and kept.
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
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  LEAF_TURN_TIMEOUT_MS,
  scanAuthSource,
  scanSdkCases,
  sdkCaseRunner,
} from "../src/engine/caserunner-sdk.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { LENS_SESSIONS_DIR, lensSessionsOf } from "../src/engine/openable.js";
import { PiHost } from "../src/engine/pisdk.js";
import type { Runtime } from "../src/engine/port.js";
import { sdkRuntime } from "../src/engine/sdkruntime.js";
import { piCaseRunner } from "../src/setup/caserunner.js";
import type { CaseOutcome, CaseSpec } from "../src/setup/engine.js";
import { useOfflineGuard } from "./pi-canary/harness.js";
import {
  FAKE_MODEL,
  startFakeOpenAI,
  writeFakeProvider,
  type FakeOpenAI,
} from "./helpers/fake-openai.js";
import { pricedFaux } from "./helpers/priced-faux.js";

useOfflineGuard({ loopback: true });

const ROOT = resolve(import.meta.dirname, "..");
const PI_BIN = join(ROOT, "node_modules", ".bin", "pi");

const AGENT = (model: string): string =>
  `---\nname: pass-survey\ntools: read, grep\nmodel: ${model}\n---\nYou are a survey lens. LEAF-BODY-MARKER\n`;

const spec: CaseSpec = {
  id: "run7/api#1",
  unit: "api",
  agent: "pass-survey",
  files: ["api/models.py"],
  prompt: "Read api/models.py and answer NONE.",
};

let dir: string;
let work: string;
let agentsDir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "scan-sdk-"));
  work = join(dir, "work");
  agentsDir = join(dir, "agents");
  mkdirSync(work);
  mkdirSync(agentsDir);
  writeFileSync(join(work, "a.txt"), "hello\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const lines = (file: string): Record<string, unknown>[] =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe("[P5.7] sdkCaseRunner on the faux provider", () => {
  const hosts: PiHost[] = [];
  afterEach(() => {
    for (const h of hosts.splice(0)) h.dispose();
  });

  /** A runner whose faux provider plays `replies` in order. */
  function runner(
    replies: Parameters<ReturnType<typeof pricedFaux>["appendResponses"]>[0],
    over: Partial<Parameters<typeof sdkCaseRunner>[0]> = {},
  ): ReturnType<typeof sdkCaseRunner> {
    writeFileSync(join(agentsDir, "pass-survey.md"), AGENT("faux/m"));
    return sdkCaseRunner({
      agentsDir,
      cwd: work,
      env: { PATH: process.env["PATH"], HOME: dir },
      runtime: async (extras) => {
        const faux = pricedFaux(
          (m) => (m.content.some((c) => c.type === "toolCall") ? 0.02 : 0.03),
          {
            provider: "faux",
            models: [{ id: "m" }],
          },
        );
        faux.appendResponses(replies);
        const host = await PiHost.create({
          agentDir: join(dir, "host-agent"),
          settings: { compaction: { enabled: false }, retry: { enabled: false } },
          configureModels: (r) => r.registerNativeProvider(faux.provider),
        });
        hosts.push(host);
        return sdkRuntime(host, { extras });
      },
      ...over,
    });
  }

  it("answers with the last assistant text, the summed cost and the files read", async () => {
    const costs: number[] = [];
    const out = await runner([
      fauxAssistantMessage([fauxToolCall("read", { path: join(work, "a.txt") })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("NONE"),
    ]).run(spec, new AbortController().signal, (c) => costs.push(c));
    expect(out).toEqual({
      ok: true,
      output: "NONE",
      cost_usd: expect.closeTo(0.05, 9),
      reads: [join(work, "a.txt")],
    });
    expect(costs).toHaveLength(2);
    expect(costs[1]).toBeCloseTo(0.05, 9);
  });

  it("does not credit a read that failed, nor a tool the guard vetoed", async () => {
    const out = await runner([
      fauxAssistantMessage([fauxToolCall("read", { path: join(work, "missing.txt") })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("NONE"),
    ]).run(spec, new AbortController().signal);
    expect(out).toMatchObject({ ok: true, output: "NONE", reads: [] });
  });

  it("keeps the transcript at the same name and in the pi --mode json shape", async () => {
    const transcriptDir = join(dir, "transcripts");
    const out = await runner(
      [
        fauxAssistantMessage([fauxToolCall("read", { path: join(work, "a.txt") })], {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("NONE"),
      ],
      { transcriptDir },
    ).run(spec, new AbortController().signal);
    expect(out).toMatchObject({ ok: true, transcript: "run7/api_1.jsonl" });
    const events = lines(join(transcriptDir, "run7", "api_1.jsonl"));
    // The header leads, then the stream, with the bulky re-emissions left out.
    expect(events[0]).toMatchObject({ type: "session", version: 3 });
    expect(events.map((e) => e["type"])).toMatchInlineSnapshot(`
      [
        "session",
        "agent_start",
        "turn_start",
        "message_start",
        "message_end",
        "message_start",
        "message_end",
        "message_start",
        "message_end",
        "tool_execution_start",
        "tool_execution_end",
        "message_start",
        "message_end",
        "turn_end",
        "turn_start",
        "message_start",
        "message_end",
        "turn_end",
        "agent_end",
        "agent_settled",
      ]
    `);
  });

  it("fails a case whose model stopped with an error, naming the model's reason", async () => {
    const out = await runner([
      fauxAssistantMessage("partial", { stopReason: "error", errorMessage: "provider said no" }),
    ]).run(spec, new AbortController().signal);
    expect(out).toMatchObject({ ok: false, reason: "provider said no" });
  });

  it("fails a case with no answer, and a model the host does not know", async () => {
    expect(
      await runner([fauxAssistantMessage("")]).run(spec, new AbortController().signal),
    ).toMatchObject({ ok: false, reason: "the subagent gave no answer" });
    const unknown = runner([]);
    writeFileSync(join(agentsDir, "pass-survey.md"), AGENT("nowhere/none"));
    const out = await unknown.run(spec, new AbortController().signal);
    expect(out).toMatchObject({ ok: false, cost_usd: 0 });
    expect((out as { reason: string }).reason).toMatch(/could not start the session.*not known/);
  });

  it("refuses without starting: a bad agent name, a missing agent, an aborted signal", async () => {
    const r = runner([]);
    expect(await r.run({ ...spec, agent: "../x" }, new AbortController().signal)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/not an agent name/),
    });
    expect(await r.run({ ...spec, agent: "nope" }, new AbortController().signal)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/no agent nope/),
    });
    const stopped = new AbortController();
    stopped.abort();
    expect(await r.run(spec, stopped.signal)).toEqual({
      ok: false,
      reason: "stopped before it started",
      cost_usd: 0,
    });
  });

  it("stops a case mid-turn on abort, reporting what it had spent", async () => {
    const stop = new AbortController();
    const hang = async (_c: unknown, o: { signal?: AbortSignal } | undefined) => {
      // The first reply is a tool call (priced); the second waits for the abort.
      await new Promise<void>((resolve) => {
        if (!o?.signal || o.signal.aborted) return resolve();
        o.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return fauxAssistantMessage("late");
    };
    const out = await runner([
      fauxAssistantMessage([fauxToolCall("read", { path: join(work, "a.txt") })], {
        stopReason: "toolUse",
      }),
      hang,
    ]).run(spec, stop.signal, (c) => {
      if (c > 0) stop.abort();
    });
    expect(out).toMatchObject({ ok: false, reason: "stopped" });
    expect((out as { cost_usd: number }).cost_usd).toBeCloseTo(0.02, 9);
  });

  it("an abort that lands while the session is being created starts no turn", async () => {
    const stop = new AbortController();
    let prompts = 0;
    writeFileSync(join(agentsDir, "pass-survey.md"), AGENT("faux/m"));
    const out = await sdkCaseRunner({
      agentsDir,
      cwd: work,
      env: { PATH: process.env["PATH"], HOME: dir },
      runtime: async () =>
        ({
          create: async () => {
            stop.abort();
            return {
              subscribe: () => () => {},
              prompt: async () => {
                prompts++;
                return { code: 0, timedOut: false };
              },
              abort: async () => {},
              dispose: async () => {},
            } as never;
          },
        }) as unknown as Runtime,
    }).run(spec, stop.signal);
    expect(prompts).toBe(0);
    expect(out).toEqual({ ok: false, reason: "stopped", cost_usd: 0 });
  });

  it("keeps the case's session JSONL beside its transcript, where `qcr open --lens CASE` finds it (D10)", async () => {
    const transcriptDir = join(dir, "transcripts-kept");
    await runner([fauxAssistantMessage("NONE")], { transcriptDir }).run(
      spec,
      new AbortController().signal,
    );
    const run = join(transcriptDir, "run7");
    const kept = lensSessionsOf(run);
    expect(kept.map((k) => k.id)).toEqual(["api_1"]);
    expect(kept[0]!.file.startsWith(join(run, LENS_SESSIONS_DIR, "api_1"))).toBe(true);
    // a session pi opens (not the event stream of the transcript beside it)
    const head = JSON.parse(readFileSync(kept[0]!.file, "utf8").split("\n", 1)[0]!);
    expect(head).toMatchObject({ type: "session", version: 3 });
    expect(SessionManager.open(kept[0]!.file).getSessionId()).toBe(head.id);
    expect(readFileSync(kept[0]!.file, "utf8")).toContain("NONE");
    // the transcript stays the transcript
    expect(lines(join(run, "api_1.jsonl"))[0]).toMatchObject({ type: "session" });
  });

  it("a transcript that cannot be written is left out, never a failed case", async () => {
    const blocked = join(dir, "blocked");
    writeFileSync(blocked, "a file, not a directory");
    const out = await runner([fauxAssistantMessage("NONE")], { transcriptDir: blocked }).run(
      spec,
      new AbortController().signal,
    );
    expect(out).toMatchObject({ ok: true, output: "NONE" });
    expect(out).not.toHaveProperty("transcript");
  });

  it("builds the session from the agent file: its tools, its body, a model with no :thinking", async () => {
    const seen: { spec?: unknown; extras?: unknown } = {};
    writeFileSync(join(agentsDir, "pass-survey.md"), AGENT("faux/m:high"));
    const out = await sdkCaseRunner({
      agentsDir,
      cwd: work,
      env: { PATH: "/bin", GITHUB_TOKEN: "ghp_secret", OPENAI_API_KEY: "sk-live", HOME: dir },
      runtime: (extras) => ({
        create: async (s) => {
          seen.spec = s;
          seen.extras = extras(s);
          throw new Error("stop here");
        },
        resume: async () => {
          throw new Error("never");
        },
      }),
    }).run(spec, new AbortController().signal);
    expect(out).toMatchObject({ ok: false, reason: "could not start the session: stop here" });
    expect(seen.spec).toMatchObject({
      cwd: work,
      model: "faux/m",
      tools: ["read", "grep"],
      name: spec.id,
      limits: { timeoutMs: LEAF_TURN_TIMEOUT_MS },
    });
    // The allowlisted env: the key variable passes, the GitHub token never does.
    const env = (seen.spec as { env: Record<string, string> }).env;
    expect(env["OPENAI_API_KEY"]).toBe("sk-live");
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
    expect(seen.extras).toMatchObject({
      thinkingLevel: "high",
      appendSystemPrompt: [expect.stringContaining("LEAF-BODY-MARKER")],
      extensions: [expect.any(Function)],
    });
    // The model's bash never draws a provider key from the leaf env.
    const allow = (seen.extras as { bashEnv: { allow: string[] } }).bashEnv.allow;
    expect(allow.join(" ")).not.toMatch(/API_KEY|TOKEN/);
  });
});

describe("[P5.7] the driver's host: a login per case, refused and read-only", () => {
  const hosts: PiHost[] = [];
  afterEach(() => {
    for (const h of hosts.splice(0)) h.dispose();
  });

  // The faux model runs on a stored key; the OAuth entry is the one whose
  // expiry the engine's admission reads.
  const login = (expires: number, refresh = "real-refresh"): string =>
    JSON.stringify({
      faux: { type: "api_key", key: "faux-key" },
      anthropic: { type: "oauth", access: "tok", refresh, expires },
    });

  function driver(env: NodeJS.ProcessEnv, onExpired: (r: string) => void) {
    writeFileSync(join(agentsDir, "pass-survey.md"), AGENT("faux/m"));
    const faux = pricedFaux(() => 0.01, { provider: "faux", models: [{ id: "m" }] });
    faux.appendResponses(Array.from({ length: 4 }, () => fauxAssistantMessage("NONE")));
    const made: Array<{ agentDir: string; credentials: unknown }> = [];
    const cases = scanSdkCases({
      agentsDir,
      cwd: work,
      env,
      agentDir: join(dir, "sdk-agent"),
      onExpired,
      makeHost: async (o) => {
        made.push(o);
        const host = await PiHost.create({
          agentDir: o.agentDir,
          credentials: o.credentials as never,
          configureModels: (r) => r.registerNativeProvider(faux.provider),
        });
        hosts.push(host);
        return host;
      },
    });
    return { cases, made };
  }

  it("reads the login from the scan container's mount first, else the pi agent dir", () => {
    expect(scanAuthSource({ QCR_SCAN_AUTH_SRC: "/mnt/pi", PI_CODING_AGENT_DIR: "/x" })).toBe(
      "/mnt/pi",
    );
    expect(scanAuthSource({ PI_CODING_AGENT_DIR: "/x" })).toBe("/x");
    expect(scanAuthSource({ HOME: "/h" })).toBe("/h/.pi/agent");
  });

  it("re-reads the login for every case and never writes it back", async () => {
    const src = join(dir, "src-agent");
    mkdirSync(src);
    const authFile = join(src, "auth.json");
    writeFileSync(authFile, login(Date.now() + 3 * 3_600_000));
    chmodSync(authFile, 0o400);
    const expired: string[] = [];
    const { cases, made } = driver({ PATH: "/bin", HOME: dir, QCR_SCAN_AUTH_SRC: src }, (r) =>
      expired.push(r),
    );
    const signal = new AbortController().signal;
    const first = await cases.run(spec, signal);
    expect(first, JSON.stringify(first)).toMatchObject({ ok: true, output: "NONE" });

    // The companion refreshed its login to a token that now expires too soon:
    // the next case is refused before a host exists, and the run is told.
    chmodSync(authFile, 0o600);
    writeFileSync(authFile, login(Date.now() + 60_000));
    const refused = await cases.run(spec, signal);
    expect(refused).toMatchObject({ ok: false, cost_usd: 0 });
    expect((refused as { reason: string }).reason).toMatch(/never refreshes it/);
    expect(expired).toHaveLength(1);
    expect(made).toHaveLength(1);

    // The source is untouched, and no auth file was written beside the host.
    expect(JSON.parse(readFileSync(authFile, "utf8")).anthropic.refresh).toBe("real-refresh");
    expect(existsSync(join(dir, "sdk-agent", "auth.json"))).toBe(false);
  });

  it("a missing login stops the run with the fix", async () => {
    const expired: string[] = [];
    const { cases, made } = driver(
      { PATH: "/bin", HOME: dir, QCR_SCAN_AUTH_SRC: join(dir, "none") },
      (r) => expired.push(r),
    );
    const out = await cases.run(spec, new AbortController().signal);
    expect(out).toMatchObject({ ok: false, reason: expect.stringMatching(/no pi login/) });
    expect(expired).toHaveLength(1);
    expect(made).toHaveLength(0);
  });

  it("host mode admits a login only if it outlives the turn's wall clock; the container's budget is the case budget", async () => {
    const src = join(dir, "src-agent");
    mkdirSync(src);
    // 40 minutes left: past the 30-minute case budget, inside the 45-minute turn.
    writeFileSync(join(src, "auth.json"), login(Date.now() + 40 * 60_000));
    const hostExpired: string[] = [];
    const host = driver({ PATH: "/bin", HOME: dir, PI_CODING_AGENT_DIR: src }, (r) =>
      hostExpired.push(r),
    );
    const refused = await host.cases.run(spec, new AbortController().signal);
    expect(refused).toMatchObject({ ok: false, cost_usd: 0 });
    expect(hostExpired).toHaveLength(1);
    expect(host.made).toHaveLength(0);

    const boxExpired: string[] = [];
    const box = driver({ PATH: "/bin", HOME: dir, QCR_SCAN_AUTH_SRC: src }, (r) =>
      boxExpired.push(r),
    );
    const admitted = await box.cases.run(spec, new AbortController().signal);
    expect(admitted, JSON.stringify(admitted)).toMatchObject({ ok: true });
    expect(boxExpired).toHaveLength(0);
  });

  it("a models.json removed from the login source is removed from the host's copy", async () => {
    const src = join(dir, "src-agent");
    mkdirSync(src);
    writeFileSync(join(src, "auth.json"), login(Date.now() + 3 * 3_600_000));
    writeFileSync(join(src, "models.json"), JSON.stringify({ providers: {} }));
    const { cases } = driver({ PATH: "/bin", HOME: dir, QCR_SCAN_AUTH_SRC: src }, () => {});
    await cases.run(spec, new AbortController().signal);
    expect(existsSync(join(dir, "sdk-agent", "models.json"))).toBe(true);
    rmSync(join(src, "models.json"));
    await cases.run(spec, new AbortController().signal);
    expect(existsSync(join(dir, "sdk-agent", "models.json"))).toBe(false);
  });

  it("gives the host the login's custom model list, and refuses a relative agent dir", async () => {
    const src = join(dir, "src-agent");
    mkdirSync(src);
    writeFileSync(join(src, "auth.json"), login(Date.now() + 3 * 3_600_000));
    writeFileSync(join(src, "models.json"), JSON.stringify({ providers: {} }));
    const { cases } = driver({ PATH: "/bin", HOME: dir, QCR_SCAN_AUTH_SRC: src }, () => {});
    await cases.run(spec, new AbortController().signal);
    expect(existsSync(join(dir, "sdk-agent", "models.json"))).toBe(true);
    expect(() =>
      scanSdkCases({
        agentsDir,
        cwd: work,
        env: {},
        agentDir: "relative/dir",
        onExpired: () => {},
      }),
    ).toThrow(/absolute/);
  });
});

describe("[P5.7] the same case on the SDK and on a real pi child, one local endpoint", () => {
  let server: FakeOpenAI;
  beforeAll(async () => {
    server = await startFakeOpenAI();
  });
  afterAll(() => server.close());

  let host: PiHost;
  beforeEach(async () => {
    server.requests.length = 0;
    writeFakeProvider(join(dir, "agent-cli"), server.baseUrl);
    writeFakeProvider(join(dir, "agent-sdk"), server.baseUrl);
    writeFileSync(join(agentsDir, "pass-survey.md"), AGENT(FAKE_MODEL));
    host = await PiHost.create({ agentDir: join(dir, "agent-sdk") });
  });
  afterEach(() => host.dispose());

  const script = (): void =>
    server.script([
      {
        toolCalls: [{ id: "call_1", name: "read", args: { path: join(work, "a.txt") } }],
        usage: { prompt: 120, completion: 12 },
      },
      { text: "NONE", usage: { prompt: 150, completion: 20 } },
    ]);

  const env = (): NodeJS.ProcessEnv => ({
    PATH: process.env["PATH"],
    HOME: join(dir, "home"),
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    PI_CODING_AGENT_DIR: join(dir, "agent-cli"),
  });

  async function both(): Promise<{
    cli: { out: CaseOutcome; bodies: string[]; events: string[] };
    sdk: { out: CaseOutcome; bodies: string[]; events: string[] };
  }> {
    const run = async (kind: "cli" | "sdk") => {
      script();
      const before = server.requests.length;
      const transcriptDir = join(dir, `transcripts-${kind}`);
      const signal = new AbortController().signal;
      const out =
        kind === "cli"
          ? await piCaseRunner({
              agentsDir,
              cwd: work,
              root: ROOT,
              env: env(),
              transcriptDir,
              invocation: { command: PI_BIN, prefix: [] },
            }).run(spec, signal)
          : await sdkCaseRunner({
              agentsDir,
              cwd: work,
              env: { ...env(), PI_CODING_AGENT_DIR: join(dir, "agent-sdk") },
              transcriptDir,
              runtime: (extras) => sdkRuntime(host, { extras }),
            }).run(spec, signal);
      return {
        out,
        bodies: server.requests.slice(before).map((r) => r.body),
        events: readFileSync(join(transcriptDir, "run7", "api_1.jsonl"), "utf8")
          .split("\n")
          .filter(Boolean),
      };
    };
    const cli = await run("cli");
    const sdk = await run("sdk");
    return { cli, sdk };
  }

  /** A body with the session's own id (the provider's cache key) masked. */
  const masked = (body: string): string =>
    body.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<session-id>");

  it("answers the same: output, cost and reads", async () => {
    const { cli, sdk } = await both();
    expect(cli.out).toMatchObject({ ok: true, output: "NONE", reads: [join(work, "a.txt")] });
    expect(sdk.out).toEqual({ ...cli.out, transcript: "run7/api_1.jsonl" });
  });

  it("sends the same requests: the system prompt, its body appended, the read-only tools", async () => {
    const { cli, sdk } = await both();
    const first = JSON.parse(cli.bodies[0]!) as { tools: { function: { name: string } }[] };
    // Not vacuous: the body and the narrowed tool list are in what both sent.
    expect(cli.bodies[0]).toContain("LEAF-BODY-MARKER");
    expect(cli.bodies[0]).toContain("Task: Read api/models.py and answer NONE.");
    expect(first.tools.map((t) => t.function.name)).toEqual(["read", "grep"]);
    expect(sdk.bodies.map(masked)).toEqual(cli.bodies.map(masked));
  });

  it("keeps a transcript of the same events, under the same keys", async () => {
    const { cli, sdk } = await both();
    // The runtime port leaves out the two re-emissions that restate a whole
    // transcript on every update (as the pi CLI does); nothing else differs.
    const kept = (ls: string[]): string[] =>
      ls.filter((l) => !/^\{"type":"(message|tool_execution)_update"/.test(l));
    const types = (ls: string[]): string[] => kept(ls).map((l) => String(JSON.parse(l).type));
    const shape = (ls: string[]): string[] =>
      [
        ...new Set(
          kept(ls).map((l) =>
            Object.keys(JSON.parse(l) as object)
              .sort()
              .join(","),
          ),
        ),
      ].sort();
    expect(cli.events.length).toBeGreaterThan(kept(cli.events).length);
    expect(types(sdk.events)).toEqual(types(cli.events));
    expect(shape(sdk.events)).toEqual(shape(cli.events));
  });
});

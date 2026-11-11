// Scan leaves on the SDK: sdkCaseRunner (src/engine/caserunner-sdk.ts),
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
  readdirSync,
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
  caseHostRoute,
  scanAuthSource,
  scanAuthWindowMs,
  scanLoginGone,
  scanRefusalWords,
  scanRoute,
  scanSdkCases,
  sdkCaseRunner,
} from "../src/engine/caserunner-sdk.js";
import { SCAN_CASE_AUTH_BUDGET_MS } from "@quickchatai/pi-quickreview/src/engine/auth.js";
import { MODEL_CHOICE_FILE } from "@quickchatai/pi-quickreview/src/modelchoice.js";
import type { ModelRoute } from "@quickchatai/pi-quickreview/src/modelroute.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  LENS_SESSIONS_DIR,
  lensSessionsOf,
} from "@quickchatai/pi-quickreview/src/engine/openable.js";
import { PiHost } from "@quickchatai/pi-quickreview/src/engine/pisdk.js";
import type { Runtime } from "@quickchatai/pi-quickreview/src/engine/port.js";
import { sdkRuntime } from "@quickchatai/pi-quickreview/src/engine/sdkruntime.js";
import { piCaseRunner } from "../src/setup/caserunner.js";
import type { CaseOutcome, CaseSpec } from "../src/setup/engine.js";
import { useOfflineGuard } from "./pi-canary/harness.js";
import {
  FAKE_MODEL,
  startFakeOpenAI,
  writeFakeProvider,
  type FakeOpenAI,
} from "./helpers/fake-openai.js";
import { ROUTABLE_FAUX_MODEL, pricedFaux, routableFaux } from "./helpers/priced-faux.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

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

describe("sdkCaseRunner on the faux provider", () => {
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

  it("keeps the case's session JSONL beside its transcript, where `qcr open --lens CASE` finds it", async () => {
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

describe("the driver's host: a login per case, refused and read-only", () => {
  const hosts: PiHost[] = [];
  afterEach(() => {
    for (const h of hosts.splice(0)) h.dispose();
  });

  // The faux model runs on a stored key; the OAuth entry is the one whose
  // expiry a case's admission reads.
  const login = (expires: number, refresh = "real-refresh"): string =>
    JSON.stringify({
      faux: { type: "api_key", key: "faux-key" },
      anthropic: { type: "oauth", access: "tok", refresh, expires },
    });

  /** The scan's route on the faux model, as a driver resolved it. */
  const FAUX_ROUTE: ModelRoute = {
    provider: "faux",
    modelId: "m",
    providerName: "Faux",
    spec: "faux/m",
    thinking: null,
    source: "only-credential",
    pick: "newest",
    piDefaultId: null,
    custom: false,
    movedFrom: null,
    credential: { kind: "api_key", origin: "stored", subscription: false },
    priced: true,
    ask: false,
    alternatives: [],
    notices: [],
  };

  function driver(
    env: NodeJS.ProcessEnv,
    onExpired: (r: string) => void,
    /** The scan's route, and an agent file that pins no model of its own. */
    route?: () => ModelRoute | undefined,
    /** A host with pi's own providers alone: the faux one is not registered,
     * so what the host can run on is what pi finds in the login and the env. */
    bare = false,
  ) {
    writeFileSync(
      join(agentsDir, "pass-survey.md"),
      route ? AGENT("faux/m").replace("model: faux/m\n", "thinking: low\n") : AGENT("faux/m"),
    );
    const faux = pricedFaux(() => 0.01, { provider: "faux", models: [{ id: "m" }] });
    faux.appendResponses(Array.from({ length: 4 }, () => fauxAssistantMessage("NONE")));
    const made: Array<{ agentDir: string; credentials: unknown; route?: unknown }> = [];
    /** The providers the host found a key for in the env, each with the variable. */
    const keyed: Array<[string, string | undefined]> = [];
    const cases = scanSdkCases({
      agentsDir,
      cwd: work,
      env,
      agentDir: join(dir, "sdk-agent"),
      onExpired,
      ...(route ? { route } : {}),
      makeHost: async (o) => {
        made.push(o);
        const host = await PiHost.create({
          agentDir: o.agentDir,
          credentials: o.credentials as never,
          authEnv: o.authEnv,
          ...(o.route ? { route: o.route } : {}),
          configureModels: async (r) => {
            if (bare) return;
            r.registerNativeProvider(faux.provider);
            // The key-only route: the faux model's key stands in for the
            // provider key the env hands a real model.
            if ((await o.credentials.read("faux")) === undefined)
              await r.setRuntimeApiKey("faux", "faux-key");
          },
        });
        for (const e of await host.inventory())
          if (e.credential.origin === "env-key") keyed.push([e.provider, e.credential.label]);
        hosts.push(host);
        return host;
      },
    });
    return { cases, made, keyed };
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

  // MUTATION: refuse a case with no login file outside the sandbox too (drop
  // `sandboxed &&` from the no-route refusal in scanSdkCases) — the first
  // case is refused with "no model credential" and this fails.
  // MUTATION: drop `authEnv` from the host scanSdkCases builds — pi looks in
  // the test process's env, finds no key, and this fails.
  it("on the host, no login but a provider key in the env runs on that key, nothing written", async () => {
    const expired: string[] = [];
    const none = join(dir, "no-pi");
    const { cases, made, keyed } = driver(
      { PATH: "/bin", HOME: dir, PI_CODING_AGENT_DIR: none, OPENAI_API_KEY: "sk-test" },
      (r) => expired.push(r),
    );
    const out = await cases.run(spec, new AbortController().signal);
    expect(out, JSON.stringify(out)).toMatchObject({ ok: true, output: "NONE" });
    expect(expired).toEqual([]);
    expect(made).toHaveLength(1);
    expect(await (made[0]!.credentials as { list(): Promise<unknown[]> }).list()).toEqual([]);
    expect(keyed).toEqual([["openai", "OPENAI_API_KEY"]]);
    expect(existsSync(join(none, "auth.json"))).toBe(false);
    expect(existsSync(join(dir, "sdk-agent", "auth.json"))).toBe(false);
  });

  // No table of key variables decides it: the host is asked what pi found.
  // MUTATION: drop the empty-inventory refusal in scanSdkCases — the case
  // starts on a host with no credential, the run is not told, and this fails.
  it("on the host, with no route and nothing pi can run on, the run stops naming `qcr login`", async () => {
    const expired: string[] = [];
    const none = join(dir, "no-pi");
    const { cases, made } = driver(
      { PATH: "/bin", HOME: dir, PI_CODING_AGENT_DIR: none },
      (r) => expired.push(r),
      undefined,
      true,
    );
    const out = await cases.run(spec, new AbortController().signal);
    expect(out).toMatchObject({ ok: false, cost_usd: 0 });
    expect((out as { reason: string }).reason).toMatch(
      /^pi has no model credential \(agent dir .*no-pi\)\. Run `qcr login`/,
    );
    expect(expired).toHaveLength(1);
    // The host was asked, and nothing was written for it.
    expect(made).toHaveLength(1);
    expect(existsSync(join(none, "auth.json"))).toBe(false);
  });

  // The scan's route was resolved over pi's whole registry: a key of any
  // provider pi knows, and no login file at all. The case is not asked for a
  // login the route never had. (The faux model's key stands in for the
  // provider's, as above; the env key is the one pi itself finds.)
  // MUTATION: refuse a routed case whenever its provider is not in the login
  // file (drop the `origin === "stored"` test in scanSdkCases) — a scan on an
  // environment key is stopped at its first case, and this fails.
  it("with a route on an environment key, of any provider pi knows, a case needs no login file", async () => {
    const expired: string[] = [];
    const none = join(dir, "no-pi");
    const { cases, made, keyed } = driver(
      { PATH: "/bin", HOME: dir, PI_CODING_AGENT_DIR: none, GROQ_API_KEY: "gsk-test" },
      (r) => expired.push(r),
      () => ({
        ...FAUX_ROUTE,
        credential: { kind: "api_key", origin: "env-key", subscription: false },
      }),
    );
    const out = await cases.run(spec, new AbortController().signal);
    expect(out, JSON.stringify(out)).toMatchObject({ ok: true, output: "NONE" });
    expect(expired).toEqual([]);
    expect(made).toHaveLength(1);
    expect(await (made[0]!.credentials as { list(): Promise<unknown[]> }).list()).toEqual([]);
    // pi found the key by its own lookup, in the env the driver handed it.
    expect(keyed).toEqual([["groq", "GROQ_API_KEY"]]);
    expect(existsSync(join(none, "auth.json"))).toBe(false);
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

  // The driver's own host and this stand-in are built from one options
  // object (`hostOptions`), so what is seen here is what `PiHost.create` gets.
  // MUTATION: drop the `route` entry from `hostOptions` in scanSdkCases — the
  // case's host is handed no route and resolves one of its own from the
  // login (another provider's, here), and this fails.
  it("with the scan's route, each case's host is handed it as fixed and runs on it", async () => {
    const src = join(dir, "src-agent");
    mkdirSync(src);
    writeFileSync(join(src, "auth.json"), login(Date.now() + 3 * 3_600_000));
    let asked = 0;
    const { cases, made } = driver(
      { PATH: "/bin", HOME: dir, QCR_SCAN_AUTH_SRC: src },
      () => {},
      () => {
        asked++;
        return FAUX_ROUTE;
      },
    );
    const signal = new AbortController().signal;
    const first = await cases.run(spec, signal);
    expect(first, JSON.stringify(first)).toMatchObject({ ok: true, output: "NONE" });
    await cases.run(spec, signal);
    // Asked per case, and every host got the same route to run on.
    expect(asked).toBe(2);
    expect(made.map((m) => m.route)).toEqual([{ fixed: FAUX_ROUTE }, { fixed: FAUX_ROUTE }]);
    // An id pi's catalog does not hold goes as a pin: the host makes pi's own
    // model object for it, which a fixed route does not carry.
    expect(caseHostRoute({ ...FAUX_ROUTE, custom: true })).toEqual({
      pin: { text: "faux/m", from: "flag" },
    });
  });

  it("before the driver resolved a route, a case's host is handed none", async () => {
    const src = join(dir, "src-agent");
    mkdirSync(src);
    writeFileSync(join(src, "auth.json"), login(Date.now() + 3 * 3_600_000));
    const { cases, made } = driver(
      { PATH: "/bin", HOME: dir, QCR_SCAN_AUTH_SRC: src },
      () => {},
      () => undefined,
    );
    // The agent pins its own model here: with no route the host is asked for none.
    writeFileSync(join(agentsDir, "pass-survey.md"), AGENT("faux/m"));
    const out = await cases.run(spec, new AbortController().signal);
    expect(out, JSON.stringify(out)).toMatchObject({ ok: true, output: "NONE" });
    expect(made).toHaveLength(1);
    expect("route" in made[0]!).toBe(false);
  });

  // The login beside the route's holds a token that ends in a minute. The
  // scan runs on the faux key: that other login is not its business.
  // MUTATION: count every login left out, route or no route (drop the
  // provider filter on `borrowed.skipped` in scanSdkCases) — the case is
  // refused for the other login, and this fails.
  it("with a route, only its provider's login has to last the case", async () => {
    const src = join(dir, "src-agent");
    mkdirSync(src);
    writeFileSync(join(src, "auth.json"), login(Date.now() + 60_000));
    const whole: string[] = [];
    const unrouted = driver({ PATH: "/bin", HOME: dir, QCR_SCAN_AUTH_SRC: src }, (r) =>
      whole.push(r),
    );
    expect(await unrouted.cases.run(spec, new AbortController().signal)).toMatchObject({
      ok: false,
    });
    expect(whole).toHaveLength(1);
    const expired: string[] = [];
    const routed = driver(
      { PATH: "/bin", HOME: dir, QCR_SCAN_AUTH_SRC: src },
      (r) => expired.push(r),
      () => FAUX_ROUTE,
    );
    const out = await routed.cases.run(spec, new AbortController().signal);
    expect(out, JSON.stringify(out)).toMatchObject({ ok: true, output: "NONE" });
    expect(expired).toEqual([]);
  });

  // MUTATION: drop the `short` refusal in scanSdkCases — a case starts on a
  // login that ends inside it, and this fails.
  it("with a route, its own provider's login that would not last the case stops the run", async () => {
    const src = join(dir, "src-agent");
    mkdirSync(src);
    writeFileSync(join(src, "auth.json"), login(Date.now() + 60_000));
    const onAnthropic: ModelRoute = {
      ...FAUX_ROUTE,
      provider: "anthropic",
      providerName: "Anthropic",
      spec: "anthropic/m",
      credential: { kind: "oauth", origin: "stored", subscription: true },
    };
    const expired: string[] = [];
    const { cases, made } = driver(
      { PATH: "/bin", HOME: dir, QCR_SCAN_AUTH_SRC: src },
      (r) => expired.push(r),
      () => onAnthropic,
    );
    const out = await cases.run(spec, new AbortController().signal);
    expect(out).toMatchObject({ ok: false, cost_usd: 0 });
    // pi's name for the provider, in the words a sandboxed scan uses.
    expect(expired).toEqual([
      expect.stringMatching(
        /^the companion's Anthropic access token expires at .*never refreshes it/,
      ),
    ]);
    expect((out as { reason: string }).reason).toBe(expired[0]);
    expect(made).toHaveLength(0);
  });

  // MUTATION: drop the `scanLoginGone` refusal in scanSdkCases — every case
  // left of the scan starts on a login that is gone, and this fails.
  it("with a route on a stored credential that is gone, the run stops naming the way back in", async () => {
    const src = join(dir, "src-agent");
    mkdirSync(src);
    // The login file is there; the route's provider is no longer in it.
    writeFileSync(
      join(src, "auth.json"),
      JSON.stringify({ other: { type: "api_key", key: "other-key" } }),
    );
    const boxed: string[] = [];
    const box = driver(
      { PATH: "/bin", HOME: dir, QCR_SCAN_AUTH_SRC: src },
      (r) => boxed.push(r),
      () => FAUX_ROUTE,
    );
    expect(await box.cases.run(spec, new AbortController().signal)).toMatchObject({
      ok: false,
      cost_usd: 0,
    });
    expect(boxed).toEqual([scanLoginGone(FAUX_ROUTE, { src, sandboxed: true })]);
    expect(boxed[0]).toMatch(/the Faux credential the companion's pi held .*run `qcr scan login`/);
    expect(box.made).toHaveLength(0);
    // On the host the login is the person's own pi's.
    const hosted: string[] = [];
    const host = driver(
      { PATH: "/bin", HOME: dir, PI_CODING_AGENT_DIR: join(dir, "no-pi") },
      (r) => hosted.push(r),
      () => FAUX_ROUTE,
    );
    expect(await host.cases.run(spec, new AbortController().signal)).toMatchObject({ ok: false });
    expect(hosted).toHaveLength(1);
    expect(hosted[0]).toMatch(/the Faux credential pi held .*run `qcr login`, then start/);
    expect(hosted[0]).not.toMatch(/qcr scan login|companion/);
  });

  // An unknown store is never taken for an empty one: the read waits out a
  // login that is being rewritten, then gives up.
  it(
    "a login file that cannot be read stops the run, and no host is built",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const src = join(dir, "src-agent");
      mkdirSync(src);
      writeFileSync(join(src, "auth.json"), "{ not json");
      const expired: string[] = [];
      const { cases, made } = driver(
        { PATH: "/bin", HOME: dir, QCR_SCAN_AUTH_SRC: src },
        (r) => expired.push(r),
        () => FAUX_ROUTE,
      );
      const out = await cases.run(spec, new AbortController().signal);
      expect(out).toMatchObject({ ok: false, cost_usd: 0 });
      expect(expired).toEqual([
        expect.stringMatching(/^could not read pi's credentials at .*auth\.json/),
      ]);
      expect(made).toHaveLength(0);
    },
  );

  // MUTATION: copy models.json alone in scanSdkCases — the models pi learned
  // since its build are unknown to the case's host, and this fails.
  it("gives the host both of pi's catalog files, as the route's host had them", async () => {
    const src = join(dir, "src-agent");
    mkdirSync(src);
    writeFileSync(join(src, "auth.json"), login(Date.now() + 3 * 3_600_000));
    writeFileSync(join(src, "models-store.json"), JSON.stringify({}));
    const { cases } = driver({ PATH: "/bin", HOME: dir, QCR_SCAN_AUTH_SRC: src }, () => {});
    await cases.run(spec, new AbortController().signal);
    expect(existsSync(join(dir, "sdk-agent", "models-store.json"))).toBe(true);
    rmSync(join(src, "models-store.json"));
    await cases.run(spec, new AbortController().signal);
    expect(existsSync(join(dir, "sdk-agent", "models-store.json"))).toBe(false);
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

// The scan's one route, resolved over the login the driver reads: no session
// is started and nothing is sent.
describe("the scan's route", () => {
  const FAUX_SPEC = (id: string): string => `${id}/${ROUTABLE_FAUX_MODEL.id}`;
  /** Registers these faux providers on every host the resolver builds. */
  const providers =
    (...ids: string[]) =>
    (r: { registerNativeProvider(p: unknown): void }): void => {
      for (const id of ids) r.registerNativeProvider(routableFaux({ provider: id }).provider);
    };
  const home = (): string => {
    const src = join(dir, "pi-agent");
    mkdirSync(src, { recursive: true });
    return src;
  };
  const resolve = (o: Partial<Parameters<typeof scanRoute>[0]> & { src: string; ids?: string[] }) =>
    scanRoute({
      env: { PATH: "/bin", HOME: dir, PI_CODING_AGENT_DIR: o.src },
      tmpDir: join(dir, "route-tmp"),
      configureModels: providers(...(o.ids ?? ["alpha"])) as never,
      ...o,
    });

  it("is what pi has a credential for, resolved on a host that is gone again", async () => {
    const src = home();
    const answer = await resolve({ src });
    expect(answer.result.ok && answer.result.route).toMatchObject({
      spec: FAUX_SPEC("alpha"),
      source: "only-credential",
      ask: false,
    });
    expect(answer.refusal).toBeUndefined();
    // The answer is plain data: the scan image prints it, the host reads it back.
    expect(JSON.parse(JSON.stringify(answer))).toEqual(answer);
    // Nothing is left of the route's host, and nothing was written beside the login.
    expect(readdirSync(join(dir, "route-tmp"))).toEqual([]);
    expect(readdirSync(src)).toEqual([]);
  });

  // MUTATION: drop `pin` from the route inputs in scanRoute — the order's
  // pick answers in place of the pinned provider, and this fails.
  it("--model is the pin, and a pin pi does not know is refused in words that name the fix", async () => {
    const src = home();
    const pinned = await resolve({
      src,
      ids: ["alpha", "beta"],
      pin: { text: FAUX_SPEC("beta"), from: "flag" },
    });
    expect(pinned.result.ok && pinned.result.route).toMatchObject({
      spec: FAUX_SPEC("beta"),
      source: "flag",
      pick: "pinned",
    });
    const unknown = await resolve({
      src,
      pin: { text: "no-such-provider/no-such-model", from: "flag" },
    });
    expect(unknown.result).toMatchObject({ ok: false, refusal: { code: "pin-unknown" } });
    expect(unknown.refusal).toMatch(/pi knows no model "no-such-provider\/no-such-model"/);
  });

  it("no credential: refused, naming the way in for a host scan and for the sandbox", async () => {
    const src = home();
    const none = await resolve({ src, ids: [] });
    expect(none.result).toEqual({ ok: false, refusal: { code: "no-credential" } });
    expect(none.refusal).toMatch(/pi has no model credential .*Run `qcr login`/);
    const boxed = await scanRoute({
      env: { PATH: "/bin", HOME: dir, QCR_SCAN_AUTH_SRC: src },
      tmpDir: join(dir, "route-tmp"),
      configureModels: providers() as never,
    });
    expect(boxed.refusal).toMatch(/no pi login in the companion's pi home .*run `qcr scan login`/);
  });

  // The read waits out a login that is being rewritten before it gives up.
  it(
    "a login file that cannot be read is an error, never an empty login",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const src = home();
      writeFileSync(join(src, "auth.json"), "{ not json");
      await expect(resolve({ src })).rejects.toThrow(/auth\.json/);
    },
  );

  // MUTATION: drop the re-resolve after the answer in scanRoute — the route
  // stays the order's pick though the person chose the other, and this fails.
  it("two providers tie: a person is asked once, and the answer is remembered beside the login", async () => {
    const src = home();
    const asked: Array<{ question: string; rows: readonly string[] }> = [];
    const said: string[] = [];
    const choose = async (question: string, rows: readonly string[]): Promise<number> => {
      asked.push({ question, rows });
      return 1;
    };
    const first = await resolve({ src, ids: ["alpha", "beta"], choose, say: (l) => said.push(l) });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.question).toBe("pi can run this scan on more than one provider:");
    // The first row is the one the order takes.
    expect(asked[0]!.rows.map((r) => r.split(/\s+/)[0])).toEqual([
      FAUX_SPEC("alpha"),
      FAUX_SPEC("beta"),
    ]);
    expect(first.result.ok && first.result.route).toMatchObject({
      spec: FAUX_SPEC("beta"),
      source: "remembered",
    });
    expect(JSON.parse(readFileSync(join(src, MODEL_CHOICE_FILE), "utf8"))).toMatchObject({
      provider: "beta",
      model: null,
      via: "ask",
    });
    expect(said.join("\n")).toMatch(/^Remembered: .+\. qcr model use <provider> changes it\.$/m);
    // The next plan, and the start after it, are not asked.
    const again = await resolve({ src, ids: ["alpha", "beta"], choose });
    expect(asked).toHaveLength(1);
    expect(again.result.ok && again.result.route.spec).toBe(FAUX_SPEC("beta"));
  });

  it("with nobody to ask, the order decides and the route says a host may ask", async () => {
    const src = home();
    const answer = await resolve({ src, ids: ["alpha", "beta"] });
    expect(answer.result.ok && answer.result.route).toMatchObject({
      spec: FAUX_SPEC("alpha"),
      ask: true,
    });
    expect(existsSync(join(src, MODEL_CHOICE_FILE))).toBe(false);
  });

  it("a login must last one case: the container's case budget, the host's whole turn", () => {
    expect(scanAuthWindowMs({ QCR_SCAN_AUTH_SRC: "/mnt/pi" })).toBe(SCAN_CASE_AUTH_BUDGET_MS);
    expect(scanAuthWindowMs({ PI_CODING_AGENT_DIR: "/x" })).toBe(LEAF_TURN_TIMEOUT_MS);
  });

  // The route's refusals speak of a review; a scan's say scan.
  // MUTATION: return `refusalText(...)` as it is from scanRefusalWords — the
  // words tell a person scanning to run a review, and this fails.
  it("a refusal names the scan, its own way into pi, and in the sandbox the companion's login", () => {
    const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
    const o = { src: "/pi", needMs: 45 * 60_000, now: () => NOW };
    const short = {
      code: "login-too-short" as const,
      logins: [{ provider: "p", name: "Prov", expiresAt: NOW + 10 * 60_000 }],
    };
    const refusals = [
      { code: "no-credential" as const },
      short,
      { code: "no-model" as const, providers: ["p"] },
      {
        code: "pin-no-credential" as const,
        pin: "p/m",
        provider: "p",
        from: "flag" as const,
        candidates: [],
      },
      { code: "pin-unknown" as const, pin: "x", detail: "no match" },
    ];
    for (const refusal of refusals) {
      const host = scanRefusalWords(refusal, { ...o, sandboxed: false });
      expect(host, refusal.code).not.toMatch(/review/i);
      expect(host, refusal.code).not.toMatch(/qcr scan login/);
      const boxed = scanRefusalWords(refusal, { ...o, sandboxed: true });
      expect(boxed, refusal.code).not.toMatch(/review/i);
      expect(boxed, refusal.code).toMatch(/qcr scan login/);
    }
    const host = scanRefusalWords(short, { ...o, sandboxed: false });
    expect(host).toMatch(/your Prov login expires at .* inside this scan's 45-minute budget/);
    expect(host).toMatch(/Run the scan inside pi \(\/qcr-scan\)/);
    expect(scanRefusalWords(short, { ...o, needMs: 30 * 60_000, sandboxed: true })).toMatch(
      /the companion's Prov access token expires at .* inside a scan case's 30-minute budget/,
    );
    expect(scanRefusalWords(refusals[3]!, { ...o, sandboxed: false })).toMatch(
      /^this scan is pinned to p\/m \(--model\)/,
    );
  });
});

describe("the same case on the SDK and on a real pi child, one local endpoint", () => {
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

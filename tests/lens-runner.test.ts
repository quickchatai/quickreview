// P4.3: runLens, the lens pass as an in-process SDK session. Everything here runs
// the real pi SDK on pi-ai's faux provider (no model, no network): the cap, the
// abort, the deadline and its one retry, a dispose that leaves a sibling alone,
// the leaf guarantee and the containment of a throwing extension.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createBashGuard } from "../extensions/bash-guard.js";
import {
  createLensRunner,
  lensSemaphoreFor,
  type LensRunConfig,
} from "../src/engine/lens/runlens.js";
import { loadBuiltAgents } from "../src/engine/lens/registry.js";
import { LENS_LEAVES_LOAD_MEMORY, PASS_TIERS, buildAgents } from "../src/include.js";
import type { PassTier } from "../src/types.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";
import { lensLogName, readLiveEvents } from "../src/live/events.js";
import { createLiveWriter } from "../src/live/writer.js";
import { parseLedger } from "../src/lensresult.js";
import {
  FakeTransport,
  createHostRig,
  useOfflineGuard,
  waitFor,
  type HostRig,
} from "./pi-canary/harness.js";

useOfflineGuard();

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let rig: HostRig;
let dir: string;
let sessions: AgentSession[];
let unhandled: unknown[];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};

const agentFile = (name: string, tools: string): string =>
  `---\nname: ${name}\ndescription: ${name} lens\nmodel: faux/faux-1\ntools: ${tools}\n---\nYou are ${name}. Report findings.\n`;

beforeEach(async () => {
  rig = await createHostRig();
  dir = mkdtempSync(join(tmpdir(), "lens-runner-"));
  mkdirSync(join(dir, "agents"));
  writeFileSync(join(dir, "agents", "pass-a.md"), agentFile("pass-a", "read, bash"));
  writeFileSync(join(dir, "agents", "pass-b.md"), agentFile("pass-b", "read, bash, grep"));
  writeFileSync(join(dir, "agents", "pass-nester.md"), agentFile("pass-nester", "read, lens_wave"));
  sessions = [];
  unhandled = [];
  process.on("unhandledRejection", onUnhandled);
  // Keep every session the host makes, to read what it carried after the run.
  const real = rig.host.makeSession.bind(rig.host);
  vi.spyOn(rig.host, "makeSession").mockImplementation(async (spec) => {
    const s = await real(spec);
    sessions.push(s);
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

function config(over: Partial<LensRunConfig> = {}): LensRunConfig {
  return {
    host: rig.host,
    permits: 4,
    registry: loadBuiltAgents(join(dir, "agents")),
    cwd: dir,
    env: { PATH: process.env["PATH"], HOME: dir },
    bashGuard: guard(),
    ledgerPath: join(dir, "round", "lens-ledger.jsonl"),
    ...over,
  };
}

const ledger = () => parseLedger(readFileSync(join(dir, "round", "lens-ledger.jsonl"), "utf8"));

/** A faux reply that waits for the abort signal (a pass that never answers). */
const hang =
  (seen?: (o: SimpleStreamOptions | undefined) => void) =>
  async (_c: TranscriptContext, options: SimpleStreamOptions | undefined) => {
    seen?.(options);
    await new Promise<void>((resolve) => {
      const s = options?.signal;
      if (!s || s.aborted) return resolve();
      s.addEventListener("abort", () => resolve(), { once: true });
    });
    return fauxAssistantMessage("late");
  };

describe("[runLens] the cap", () => {
  it("never has more passes in flight than the host's permits, and frees every permit", async () => {
    let inFlight = 0;
    let peak = 0;
    rig.faux.setResponses(
      Array.from({ length: 6 }, () => async () => {
        peak = Math.max(peak, ++inFlight);
        await sleep(25);
        inFlight--;
        return fauxAssistantMessage("found nothing");
      }),
    );
    const runner = createLensRunner(config({ permits: 2 }));
    const runs = await Promise.all(
      Array.from({ length: 6 }, (_, i) => runner.run({ agent: "pass-a", task: `row ${i}` })),
    );
    expect(peak).toBe(2);
    expect(runs.every((r) => r.result.exitCode === 0 && r.text === "found nothing")).toBe(true);
    expect(lensSemaphoreFor(rig.host, 2).held).toBe(0);
    expect(runner.liveSessions()).toBe(0);
  });

  it("is one cap per host: a second runner shares it, and a different number is refused", async () => {
    let inFlight = 0;
    let peak = 0;
    rig.faux.setResponses(
      Array.from({ length: 4 }, () => async () => {
        peak = Math.max(peak, ++inFlight);
        await sleep(25);
        inFlight--;
        return fauxAssistantMessage("ok");
      }),
    );
    const one = createLensRunner(config({ permits: 1 }));
    const two = createLensRunner(
      config({ permits: 1, ledgerPath: join(dir, "round", "other.jsonl") }),
    );
    expect(() => createLensRunner(config({ permits: 3 }))).toThrow(/one cap per host/);
    await Promise.all([
      one.run({ agent: "pass-a", task: "1" }),
      two.run({ agent: "pass-a", task: "2" }),
      one.run({ agent: "pass-b", task: "3" }),
      two.run({ agent: "pass-b", task: "4" }),
    ]);
    expect(peak).toBe(1);
  });
});

describe("[runLens] a pass", () => {
  it("is built the native way: the body appended, D34 context files as data, unique ids", async () => {
    rig.faux.setResponses([() => fauxAssistantMessage("a"), () => fauxAssistantMessage("b")]);
    const runner = createLensRunner(
      config({ agentsFiles: [{ path: join(dir, "AGENTS.md"), content: "REVIEWER-STUB-TEXT" }] }),
    );
    const [a, b] = await Promise.all([
      runner.run({ agent: "pass-a", task: "t1" }),
      runner.run({ agent: "pass-a", task: "t2" }),
    ]);
    expect(sessions).toHaveLength(2);
    expect(new Set(sessions.map((s) => s.sessionId)).size).toBe(2);
    for (const s of sessions) {
      expect(s.systemPrompt).toContain("You are pass-a. Report findings.");
      expect(s.systemPrompt).toContain("REVIEWER-STUB-TEXT");
      expect(s.sessionFile).toBeUndefined();
    }
    expect(existsSync(join(dir, "AGENTS.md")), "nothing is written into the cwd").toBe(false);
    const asked = (r: typeof a): string =>
      JSON.stringify(r.result.messages.find((m) => m.role === "user")?.content);
    expect(asked(a)).toContain("Task: t1");
    expect(asked(b)).toContain("Task: t2");
  });

  it("is read: text, usage, stop reason and timestamped messages, with one ledger line", async () => {
    rig.faux.setResponses([() => fauxAssistantMessage("the answer")]);
    const runner = createLensRunner(config());
    const { result, text } = await runner.run({ agent: "pass-a", task: "go" });
    expect(text).toBe("the answer");
    expect(result).toMatchObject({ agent: "pass-a", exitCode: 0, stopReason: "stop" });
    expect(result.id).toBeTruthy();
    expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(result.messages.every((m) => typeof m.timestamp === "number")).toBe(true);
    expect(result.usage.output).toBeGreaterThan(0);
    const lines = ledger();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: "lens", id: result.id, agent: "pass-a", exitCode: 0 });
    expect(lines[0]?.usage).toEqual(result.usage);
  });

  it("writes its lifecycle to the round-progress log through the shared writer", async () => {
    rig.faux.setResponses([() => fauxAssistantMessage("ok"), () => fauxAssistantMessage("ok")]);
    const logPath = join(dir, "state", "round-progress", "pr-7.jsonl");
    const runner = createLensRunner(
      config({
        progress: {
          logPath,
          pr: 7,
          session: "pr-7",
          runStartedAt: "2026-10-19T00:00:00.000Z",
          commandId: "c1",
        },
      }),
    );
    const { result } = await runner.run({ agent: "pass-a", task: "go" });
    const bad = await runner.run({ agent: "pass-zzz", task: "go" });
    const lines = readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => l["event"])).toEqual(["pass_start", "pass_end"]);
    expect(lines[0]).toMatchObject({
      pr: 7,
      session: "pr-7",
      command_id: "c1",
      execution_id: result.id,
      agent: "pass-a",
    });
    expect(lines[1]).toMatchObject({ execution_id: result.id, status: "completed" });
    expect(bad.result.exitCode, "an unknown agent never started").toBe(1);
  });

  it("logs the pass's own session to lens-<id>.jsonl when given a live sink", async () => {
    rig.faux.setResponses([() => fauxAssistantMessage("found nothing")]);
    const writer = createLiveWriter({ dir: join(dir, "live") });
    const runner = createLensRunner(
      config({
        live: (id, agent) =>
          writer.lens(id, { key: "pr-7", round: 1, pr: 7, session: "pr-7", agent }),
      }),
    );
    const { result } = await runner.run({ agent: "pass-a", task: "go" });
    const events = readLiveEvents(join(dir, "live", lensLogName(result.id!))).events;
    expect(events[0]).toMatchObject({
      type: "session_start",
      stream: "lens",
      lens_id: result.id,
      agent: "pass-a",
    });
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(["agent_start", "message_end", "agent_settled"]),
    );
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
  });

  it("a live sink that cannot be made costs the pass nothing", async () => {
    rig.faux.setResponses([() => fauxAssistantMessage("ok")]);
    const runner = createLensRunner(
      config({
        live: () => {
          throw new Error("no disk");
        },
        warn: () => {},
      }),
    );
    expect((await runner.run({ agent: "pass-a", task: "go" })).result.exitCode).toBe(0);
  });

  it("a failed provider turn is a failed lens, with its ledger line", async () => {
    rig.faux.setResponses([
      () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "529 overloaded" }),
    ]);
    const runner = createLensRunner(config());
    const { result } = await runner.run({ agent: "pass-a", task: "go" });
    expect(result).toMatchObject({
      exitCode: 1,
      stopReason: "error",
      errorMessage: "529 overloaded",
    });
    expect(ledger()[0]).toMatchObject({ exitCode: 1, stopReason: "error" });
  });
});

describe("[runLens] abort and deadline", () => {
  it("a caller's abort reaches the child: the turn is cut, the result says aborted, the permit returns", async () => {
    let started: () => void;
    const running = new Promise<void>((r) => (started = r));
    let signalSeen: AbortSignal | undefined;
    rig.faux.setResponses([
      hang((o) => {
        signalSeen = o?.signal;
        started();
      }),
    ]);
    const runner = createLensRunner(config({ permits: 1 }));
    const ac = new AbortController();
    const run = runner.run({ agent: "pass-a", task: "go", signal: ac.signal });
    await running;
    ac.abort();
    const { result } = await run;
    expect(signalSeen?.aborted).toBe(true);
    expect(result).toMatchObject({ exitCode: 1, stopReason: "aborted" });
    expect(lensSemaphoreFor(rig.host, 1).held).toBe(0);
    expect(runner.liveSessions()).toBe(0);
    expect(ledger()).toHaveLength(1);
  });

  it("an abort before the pass starts never builds a session", async () => {
    const runner = createLensRunner(config());
    const ac = new AbortController();
    ac.abort();
    const { result } = await runner.run({ agent: "pass-a", task: "go", signal: ac.signal });
    expect(result).toMatchObject({ exitCode: 1, stopReason: "aborted" });
    expect(sessions).toHaveLength(0);
  });

  it("the deadline aborts, retries ONCE on a fresh session, and the retry's answer stands", async () => {
    const ids: (string | undefined)[] = [];
    rig.faux.setResponses([
      hang((o) => ids.push(o?.sessionId)),
      async (_c, o) => {
        ids.push(o?.sessionId);
        return fauxAssistantMessage("second time lucky");
      },
    ]);
    const runner = createLensRunner(config({ deadlineMs: 60 }));
    const { result, text } = await runner.run({ agent: "pass-a", task: "go" });
    expect(text).toBe("second time lucky");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBeUndefined();
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    expect(sessions).toHaveLength(2);
    expect(ledger()).toHaveLength(1);
  });

  it("times out after the second attempt, once, with the timeout named and the permit back", async () => {
    let calls = 0;
    rig.faux.setResponses(
      Array.from({ length: 4 }, () =>
        hang(() => {
          calls++;
        }),
      ),
    );
    const runner = createLensRunner(config({ permits: 1, deadlineMs: 60 }));
    const { result } = await runner.run({ agent: "pass-a", task: "go" });
    expect(calls).toBe(2);
    expect(result).toMatchObject({ exitCode: 1, timedOut: true });
    expect(result.errorMessage).toMatch(/^pass pass-a timed out after .* min \(retried once\)$/);
    expect(lensSemaphoreFor(rig.host, 1).held).toBe(0);
    expect(ledger()[0]).toMatchObject({ timedOut: true, exitCode: 1 });
  });
});

describe("[runLens] isolation", () => {
  it("disposing a finished pass A leaves sibling B streaming on its own session id", async () => {
    const transport = new FakeTransport();
    transport.attach();
    try {
      let releaseB!: () => void;
      const gate = new Promise<void>((r) => (releaseB = r));
      const order: string[] = [];
      rig.faux.setResponses([
        async (_c, o) => {
          transport.open(o?.sessionId);
          order.push("A");
          return fauxAssistantMessage("a done");
        },
        async (_c, o) => {
          transport.open(o?.sessionId);
          order.push("B");
          await gate;
          return fauxAssistantMessage("b done");
        },
      ]);
      const runner = createLensRunner(config());
      const a = runner.run({ agent: "pass-a", task: "a" });
      await waitFor(() => order.includes("A"));
      const b = runner.run({ agent: "pass-b", task: "b" });
      await waitFor(() => order.includes("B"));
      expect((await a).text).toBe("a done");
      const [sa, sb] = sessions as [AgentSession, AgentSession];
      expect(transport.cleanups).toEqual([sa.sessionId]);
      expect(transport.isOpen(sa.sessionId)).toBe(false);
      expect(transport.isOpen(sb.sessionId), "B is still streaming").toBe(true);
      releaseB();
      expect((await b).text).toBe("b done");
      expect(transport.cleanups).toEqual([sa.sessionId, sb.sessionId]);
    } finally {
      transport.detach();
    }
  });

  it("a leaf sees no lens tool: its tools are its frontmatter's, and an agent naming one is refused", async () => {
    rig.faux.setResponses([() => fauxAssistantMessage("ok")]);
    const runner = createLensRunner(config());
    await runner.run({ agent: "pass-b", task: "go" });
    const tools = sessions[0]!
      .getAllTools()
      .map((t) => t.name)
      .sort();
    expect(tools).toEqual(["bash", "grep", "read"]);
    for (const banned of ["lens", "lens_wave", "subagent", "launch_plan"])
      expect(tools).not.toContain(banned);

    const nested = await runner.run({ agent: "pass-nester", task: "go" });
    expect(nested.result.exitCode).toBe(1);
    expect(nested.result.errorMessage).toMatch(/lists a lens tool \(lens_wave\)/);
    expect(sessions, "no session was built for it").toHaveLength(1);
  });

  it("the bash guard is attached: a denied command does not run", async () => {
    const marker = join(dir, "ran");
    rig.faux.setResponses([
      () =>
        fauxAssistantMessage(
          [fauxToolCall("bash", { command: `cat /proc/self/environ > ${marker}` })],
          {
            stopReason: "toolUse",
          },
        ),
      () => fauxAssistantMessage("blocked, carrying on"),
    ]);
    const runner = createLensRunner(config());
    const { result, text } = await runner.run({ agent: "pass-a", task: "go" });
    expect(existsSync(marker)).toBe(false);
    expect(text).toBe("blocked, carrying on");
    const tr = result.messages.find((m) => m.role === "toolResult");
    expect(tr?.["isError"]).toBe(true);
  });
});

describe("[runLens] a throwing extension is contained", () => {
  it("handlers that throw are reported, never crash the host, and the pass still answers", async () => {
    const heard: string[] = [];
    const thrower: ExtensionFactory = (pi) => {
      pi.on("agent_start", async () => {
        await sleep(2);
        throw new Error("agent_start boom");
      });
      pi.on("turn_end", async () => {
        throw new Error("turn_end boom");
      });
    };
    rig.faux.setResponses([() => fauxAssistantMessage("fine")]);
    const runner = createLensRunner(
      config({
        bashGuard: (pi) => {
          void guard()(pi);
          void thrower(pi);
        },
        onExtensionError: (agent, _id, e) => heard.push(`${agent}:${e.error}`),
      }),
    );
    const { result, text } = await runner.run({ agent: "pass-a", task: "go" });
    expect(text).toBe("fine");
    expect(result.exitCode).toBe(0);
    expect(heard).toEqual(
      expect.arrayContaining(["pass-a:agent_start boom", "pass-a:turn_end boom"]),
    );
  });

  it("a host that cannot build the session makes a failed lens, not a rejection", async () => {
    vi.mocked(rig.host.makeSession).mockRejectedValueOnce(new Error("extension factory exploded"));
    const runner = createLensRunner(config({ permits: 1 }));
    const { result } = await runner.run({ agent: "pass-a", task: "go" });
    expect(result).toMatchObject({ exitCode: 1, stopReason: "error" });
    expect(result.errorMessage).toContain("extension factory exploded");
    expect(lensSemaphoreFor(rig.host, 1).held).toBe(0);
    expect(ledger()).toHaveLength(1);
    // The runner is still usable.
    rig.faux.setResponses([() => fauxAssistantMessage("back")]);
    expect((await runner.run({ agent: "pass-a", task: "again" })).text).toBe("back");
  });

  it("a guard that throws on a tool call fails closed and the pass carries on", async () => {
    const marker = join(dir, "ran");
    rig.faux.setResponses([
      () =>
        fauxAssistantMessage([fauxToolCall("bash", { command: `touch ${marker}` })], {
          stopReason: "toolUse",
        }),
      () => fauxAssistantMessage("carried on"),
    ]);
    const runner = createLensRunner(
      config({
        bashGuard: (pi) => {
          pi.on("tool_call", async () => {
            throw new Error("guard boom");
          });
        },
      }),
    );
    const { result, text } = await runner.run({ agent: "pass-a", task: "go" });
    expect(existsSync(marker)).toBe(false);
    expect(text).toBe("carried on");
    expect(result.exitCode).toBe(0);
  });
});

// The tools line of a built lens is the leaf's allowlist, and pi ignores an
// allowlisted name nothing registers — so a name the leaf never has (a memory
// tool with no memory extension, a `glob` pi has no tool for) costs nothing at
// runtime and says something false. The truth is what the runner's session
// holds: it loads the bash guard and the leaf cache, never the memory
// extension (LENS_LEAVES_LOAD_MEMORY), so every name a default build of the
// real agents/ puts on a tools line must be a tool its session carries.
describe("[runLens] a built lens names only tools its leaf holds", () => {
  it(
    "every name on a default-built agent's tools line is a tool its session has; no memory tool",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const root = join(dirname(fileURLToPath(import.meta.url)), "..");
      const out = join(dir, "built");
      const tiers = Object.fromEntries(PASS_TIERS.map((t) => [t, "faux/faux-1"])) as Record<
        PassTier,
        string
      >;
      const built = buildAgents(join(root, "agents"), out, {
        root,
        tiers,
        riskPasses: [],
        validateTier: "terra-med",
      });
      // One session per distinct tools line: the line is what is under test.
      const byLine = new Map<string, string>();
      for (const a of built) {
        const line = /^tools:[ \t]*(.*)$/m.exec(readFileSync(a.output, "utf8"))?.[1] ?? "";
        if (!byLine.has(line)) byLine.set(line, a.name);
      }
      expect(byLine.size).toBeGreaterThan(0);
      expect(LENS_LEAVES_LOAD_MEMORY).toBe(false);
      rig.faux.setResponses(
        Array.from({ length: byLine.size }, () => () => fauxAssistantMessage("fine")),
      );
      const runner = createLensRunner(config({ registry: loadBuiltAgents(out) }));
      for (const [line, name] of byLine) {
        const before = sessions.length;
        const { result } = await runner.run({ agent: name, task: "go" });
        expect(result.exitCode, `${name}: ${result.errorMessage ?? ""}`).toBe(0);
        const held = sessions[before]!.getAllTools().map((t) => t.name);
        const named = line
          .split(",")
          .map((t) => t.trim())
          .filter((t) => t.length > 0);
        for (const tool of named) expect(held, `${name} names ${tool}`).toContain(tool);
        expect(
          held.filter((t) => t.startsWith("viking_")),
          name,
        ).toEqual([]);
      }
    },
  );
});

describe("[canary] every lens session carries bash-guard", () => {
  it("in every session the runner makes: the plain pass, the cached pass and the group's warm-up", async () => {
    const marked = guard();
    rig.faux.setResponses(Array.from({ length: 6 }, () => () => fauxAssistantMessage("fine")));
    const runner = createLensRunner(
      config({ bashGuard: marked, cache: { size: 2, staggerMs: 0, pack: "PACK" } }),
    );
    await runner.run({ agent: "pass-a", task: "go" });
    await runner.run({ agent: "pass-a", task: "again" });
    const plain = createLensRunner(config({ bashGuard: marked }));
    await plain.run({ agent: "pass-a", task: "plain" });
    const made = vi.mocked(rig.host.makeSession).mock.calls.map(([spec]) => spec);
    // the plain pass, two cached passes and the warm-up: no session without the guard
    expect(made.length).toBeGreaterThanOrEqual(3);
    for (const spec of made) expect(spec.extensions?.[0]).toBe(marked);
  });

  it("the runner config has no way to leave it out: bashGuard is required", () => {
    // @ts-expect-error a LensRunConfig without bashGuard does not typecheck
    const bad: LensRunConfig = { ...config(), bashGuard: undefined };
    expect(bad.bashGuard).toBeUndefined();
  });
});

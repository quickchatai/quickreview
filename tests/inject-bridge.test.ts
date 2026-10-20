// inject-bridge consume/defer semantics. A round prompt handed to a session
// that is still streaming must never be silently dropped; a dropped prompt
// leaves the round "running" until its deadline.
//
// The contract under test, in three layers — each covering a different half:
//   1. a file remains pending after fire-and-forget submission and is consumed
//      only when the run-start message correlates its injected marker;
//   2. while that run is active no successor submits, and only a deferred
//      `agent_settled` drain may advance the queue (`turn_end` is an
//      inner-loop event and clearing on it re-opens every tool-call gap);
//   3. every send still carries `deliverAs: "followUp"` as a belt, while a
//      missing start acknowledgement expires loudly and preserves the file.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import activate, { RETRY_BASE_MS, START_ACK_TIMEOUT_MS } from "../extensions/inject-bridge.js";
import { readSessionBridgeState } from "../src/session-bridge.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

let dir: string;
let handlers: Map<string, Array<(...args: unknown[]) => unknown>>;
let sends: Array<{ content: string; options?: { deliverAs?: string } }>;
// Pi declares the extension-facing submission as `void`.
// The internal Promise is intentionally unavailable to extensions, so this
// fake must never offer tests stronger serialization than production has.
let sendImpl: (content: string) => void;
let savedEnv: {
  inject?: string;
  session?: string;
  stateDb?: string;
  root?: string;
  bridgeGeneration?: string;
  bridgeStateFile?: string;
};

function fakePi(): ExtensionAPI {
  return {
    on(event: string, handler: (...args: unknown[]) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendUserMessage(content: string, options?: { deliverAs?: string }): void {
      sends.push({ content, ...(options ? { options } : {}) });
      sendImpl(content);
    },
  } as unknown as ExtensionAPI;
}

function fire(event: string, payload: unknown = {}, context?: unknown): void {
  for (const h of handlers.get(event) ?? []) h(payload, context);
}

function sentBody(index: number): string {
  return sends[index]!.content.replace(/\n\n<!-- qcr-inject:[^\n]+ -->$/, "");
}

function acknowledgeLatest(): void {
  const content = sends.at(-1)!.content;
  fire("agent_start");
  fire("message_start", { message: { role: "user", content: [{ type: "text", text: content }] } });
}

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

function pending(): string[] {
  return readdirSync(dir).filter((f) => f.endsWith(".md"));
}
function done(): string[] {
  const d = join(dir, ".done");
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".md")) : [];
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-bridge-"));
  handlers = new Map();
  sends = [];
  sendImpl = () => {};
  savedEnv = {
    inject: process.env.QCR_INJECT_DIR,
    session: process.env.QCR_SESSION_NAME,
    stateDb: process.env.QCR_STATE_DB,
    root: process.env.QCR_SANDBOX_ROOT,
    bridgeGeneration: process.env.QCR_SESSION_BRIDGE_GENERATION,
    bridgeStateFile: process.env.QCR_SESSION_BRIDGE_STATE_FILE,
  };
  process.env.QCR_INJECT_DIR = dir;
  process.env.QCR_SESSION_NAME = "pr-1";
  process.env.QCR_SESSION_BRIDGE_GENERATION = "generation-1";
  process.env.QCR_SESSION_BRIDGE_STATE_FILE = join(dir, "bridge-state.json");
  delete process.env.QCR_STATE_DB;
  delete process.env.QCR_SANDBOX_ROOT;
});

afterEach(() => {
  fire("session_shutdown"); // closes the watcher and cancels bridge timers
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (savedEnv.inject === undefined) delete process.env.QCR_INJECT_DIR;
  else process.env.QCR_INJECT_DIR = savedEnv.inject;
  if (savedEnv.session === undefined) delete process.env.QCR_SESSION_NAME;
  else process.env.QCR_SESSION_NAME = savedEnv.session;
  if (savedEnv.stateDb === undefined) delete process.env.QCR_STATE_DB;
  else process.env.QCR_STATE_DB = savedEnv.stateDb;
  if (savedEnv.root === undefined) delete process.env.QCR_SANDBOX_ROOT;
  else process.env.QCR_SANDBOX_ROOT = savedEnv.root;
  if (savedEnv.bridgeGeneration === undefined) delete process.env.QCR_SESSION_BRIDGE_GENERATION;
  else process.env.QCR_SESSION_BRIDGE_GENERATION = savedEnv.bridgeGeneration;
  if (savedEnv.bridgeStateFile === undefined) delete process.env.QCR_SESSION_BRIDGE_STATE_FILE;
  else process.env.QCR_SESSION_BRIDGE_STATE_FILE = savedEnv.bridgeStateFile;
  rmSync(dir, { recursive: true, force: true });
});

describe("inject-bridge — start-acknowledged single flight", () => {
  it("retains a submitted file until its correlated run-start message", async () => {
    writeFileSync(join(dir, "2026-08-20T11-23-20-0000.md"), "ROUND 2 prompt");

    activate(fakePi());
    fire("session_start");

    expect(readSessionBridgeState(process.env.QCR_SESSION_BRIDGE_STATE_FILE!)).toMatchObject({
      session: "pr-1",
      generation: "generation-1",
      stage: "ready",
    });
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    expect(pending()).toHaveLength(1);
    expect(done()).toHaveLength(0);

    acknowledgeLatest();
    await vi.waitFor(() => expect(done()).toHaveLength(1));
    expect(pending()).toHaveLength(0);
  });

  it("has no self-retirement protocol: a retire-request file never exits the process", async () => {
    process.env.QCR_SESSION_NAME = "companion";
    process.env.QCR_SANDBOX_ROOT = dir;
    mkdirSync(join(dir, "state", "sessions"), { recursive: true });
    writeFileSync(
      join(dir, "state", "sessions", "companion.json"),
      JSON.stringify({ session: "companion", bridge_generation: "generation-1" }),
    );
    writeFileSync(
      join(dir, ".overseer-retire-request.json"),
      JSON.stringify({ version: 1, generation: "generation-1", nonce: "request" }),
    );
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    activate(fakePi());
    fire("session_start", {}, { isIdle: () => true, hasPendingMessages: () => false });
    fire("agent_settled", {}, { isIdle: () => true, hasPendingMessages: () => false });
    await sleep(30);
    expect(exit).not.toHaveBeenCalled();
  });

  it("publishes accepted unfinished work after its transport file has been archived", async () => {
    process.env.QCR_SESSION_NAME = "companion";
    writeFileSync(join(dir, "accepted.md"), "accepted work");
    activate(fakePi());
    fire("session_start");
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    acknowledgeLatest();
    expect(pending()).toEqual([]);
    expect(done()).toHaveLength(1);
    const state = () => readSessionBridgeState(process.env.QCR_SESSION_BRIDGE_STATE_FILE!);
    expect(state()).toMatchObject({ stage: "ready", run_status: "active" });
    fire("agent_end");
    expect(state()).toMatchObject({ run_status: "active" });
    fire("agent_settled");
    await vi.waitFor(() => expect(state()).toMatchObject({ run_status: "idle" }));
  });

  it("does not let an unrelated agent run acknowledge the submitted wake", async () => {
    writeFileSync(join(dir, "2026-08-20T11-23-21-0000.md"), "daemon prompt");
    activate(fakePi());
    fire("session_start");
    await vi.waitFor(() => expect(sends).toHaveLength(1));

    fire("agent_start");
    fire("message_start", {
      message: { role: "user", content: [{ type: "text", text: "interactive operator prompt" }] },
    });
    expect(pending()).toHaveLength(1);
    expect(done()).toHaveLength(0);

    fire("message_start", {
      message: { role: "user", content: [{ type: "text", text: sends[0]!.content }] },
    });
    await vi.waitFor(() => expect(done()).toHaveLength(1));
  });

  it("treats auto-retry agent_start events as one outer run with one settlement", async () => {
    activate(fakePi());
    fire("session_start");
    fire("agent_start");
    fire("agent_start"); // pinned Pi emits this again for agent.continue retry
    writeFileSync(join(dir, "2026-08-20T11-23-22-0000.md"), "pending");
    await sleep(150);
    expect(sends).toHaveLength(0);

    fire("agent_settled"); // one settlement covers the whole retrying run
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    expect(sentBody(0)).toBe("pending");
  });

  it("a synchronous adapter failure retries on its timer and still requires correlated acceptance", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    sendImpl = () => {
      calls++;
      if (calls === 1) throw new Error("adapter failed synchronously");
    };
    writeFileSync(join(dir, "2026-08-20T12-42-02-0000.md"), "round prompt");

    activate(fakePi());
    fire("session_start");

    expect(sends).toHaveLength(1);
    expect(pending()).toHaveLength(1);
    expect(done()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS);
    expect(sends).toHaveLength(2);
    expect(pending()).toHaveLength(1);
    acknowledgeLatest();
    expect(done()).toHaveLength(1);
  });

  it("an invisible asynchronous rejection expires loudly and preserves recoverable evidence", async () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    sendImpl = () => {
      void Promise.reject(new Error("prompt preflight failed")).catch(() => {});
    };
    writeFileSync(join(dir, "2026-08-20T12-42-03-0000.md"), "lost round prompt");

    activate(fakePi());
    fire("session_start");
    await vi.advanceTimersByTimeAsync(0);
    expect(sends).toHaveLength(1);
    expect(pending()).toHaveLength(1);
    expect(done()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(START_ACK_TIMEOUT_MS);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("FAILED_LOUD"));
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("2026-08-20T12-42-03-0000.md"));
    expect(pending()).toHaveLength(1);
    expect(done()).toHaveLength(0);
    expect(sends).toHaveLength(1); // no blind retry storm
  });

  it("defers while a run is active, then waits for start acknowledgement after settle", async () => {
    activate(fakePi());
    fire("session_start");
    fire("turn_start");

    writeFileSync(join(dir, "2026-08-20T11-23-20-0001.md"), "held round prompt");
    await sleep(150);
    expect(sends).toHaveLength(0);
    expect(pending()).toHaveLength(1);

    fire("agent_settled");
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    expect(done()).toHaveLength(0);
    acknowledgeLatest();
    await vi.waitFor(() => expect(done()).toHaveLength(1));
  });

  it("settlement schedules the next submission after event dispatch, never re-entrantly", async () => {
    activate(fakePi());
    fire("session_start");
    fire("agent_start");
    writeFileSync(join(dir, "2026-08-20T11-23-20-0002.md"), "deferred prompt");
    await sleep(150);
    expect(sends).toHaveLength(0);

    fire("agent_settled");
    expect(sends).toHaveLength(0); // the callback returned before Pi submission
    await vi.waitFor(() => expect(sends).toHaveLength(1));
  });

  it("does not let an older settlement release a run that starts before the deferred drain", async () => {
    activate(fakePi());
    fire("session_start");
    fire("agent_start");
    writeFileSync(join(dir, "2026-08-20T11-23-20-0003.md"), "deferred prompt");
    await sleep(150);

    fire("agent_settled");
    fire("agent_start"); // a newer run begins before the zero-delay drain
    await sleep(20);
    expect(sends).toHaveLength(0);

    fire("agent_settled");
    await vi.waitFor(() => expect(sends).toHaveLength(1));
  });

  it("retains a newer settlement that arrives before the older deferred drain", async () => {
    activate(fakePi());
    fire("session_start");
    fire("agent_start");
    writeFileSync(join(dir, "2026-08-20T11-23-20-0004.md"), "deferred prompt");
    await sleep(150);

    fire("agent_settled");
    fire("agent_start");
    fire("agent_settled");
    expect(sends).toHaveLength(0); // never re-entrant
    await vi.waitFor(() => expect(sends).toHaveLength(1));
  });

  it(
    "never overrides an active run merely because the old 15-minute hold elapsed",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const t0 = Date.now();
      const now = vi.spyOn(Date, "now").mockReturnValue(t0);
      activate(fakePi());
      fire("session_start");
      fire("agent_start");

      writeFileSync(join(dir, "2026-08-20T13-00-00-0000.md"), "wake A");
      await sleep(150);
      now.mockReturnValue(t0 + 15 * 60_000 + 1);
      writeFileSync(join(dir, "2026-08-20T13-00-01-0000.md"), "wake B");
      await sleep(150);

      expect(sends).toHaveLength(0);
      expect(pending()).toHaveLength(2);
      expect(done()).toHaveLength(0);
    },
  );

  it("submits at most one wake, then waits for its acknowledged run to settle", async () => {
    writeFileSync(join(dir, "2026-08-20T14-00-00-0000.md"), "first");
    writeFileSync(join(dir, "2026-08-20T14-00-01-0000.md"), "second");
    activate(fakePi());
    fire("session_start");

    await vi.waitFor(() => expect(sends).toHaveLength(1));
    expect(sentBody(0)).toBe("first");
    expect(pending()).toHaveLength(2);

    acknowledgeLatest();
    await vi.waitFor(() => expect(done()).toHaveLength(1));
    expect(sends).toHaveLength(1); // acknowledged, but its run is active

    fire("agent_settled");
    await vi.waitFor(() => expect(sends).toHaveLength(2));
    expect(sentBody(1)).toBe("second");
    expect(pending()).toHaveLength(1);
    acknowledgeLatest();
    await vi.waitFor(() => expect(done()).toHaveLength(2));
  });

  it("orders three author replies before a round prompt without loss or interleaving", async () => {
    const messages = ["reply A", "reply B", "reply C", "ROUND 20 prompt"];
    for (const [index, message] of messages.entries()) {
      writeFileSync(join(dir, `2026-08-20T14-01-0${index}-0000.md`), message);
    }
    activate(fakePi());
    fire("session_start");

    for (let index = 0; index < messages.length; index++) {
      await vi.waitFor(() => expect(sends).toHaveLength(index + 1));
      expect(sentBody(index)).toBe(messages[index]);
      expect(done()).toHaveLength(index);
      acknowledgeLatest();
      await vi.waitFor(() => expect(done()).toHaveLength(index + 1));
      expect(sends).toHaveLength(index + 1);
      fire("agent_settled");
    }
    await sleep(20);
    expect(sends).toHaveLength(messages.length);
    expect(pending()).toHaveLength(0);
  });

  it("retries an acknowledged archive failure on settlement before advancing", async () => {
    const file = "2026-08-20T14-01-09-0000.md";
    writeFileSync(join(dir, file), "prompt");
    mkdirSync(join(dir, ".done", file), { recursive: true });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    activate(fakePi());
    fire("session_start");
    await vi.waitFor(() => expect(sends).toHaveLength(1));

    acknowledgeLatest();
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("FAILED_LOUD"));
    expect(pending()).toHaveLength(1);

    rmSync(join(dir, ".done", file), { recursive: true });
    fire("agent_settled");
    await vi.waitFor(() => expect(done()).toHaveLength(1));
    expect(pending()).toHaveLength(0);
  });

  it("handles correlated run events emitted during the submission call", async () => {
    sendImpl = (content) => {
      fire("agent_start");
      fire("message_start", {
        message: { role: "user", content: [{ type: "text", text: content }] },
      });
    };
    writeFileSync(join(dir, "2026-08-20T14-02-00-0000.md"), "prompt");
    activate(fakePi());
    fire("session_start");

    await vi.waitFor(() => expect(sends).toHaveLength(1));
    await vi.waitFor(() => expect(done()).toHaveLength(1));
    expect(pending()).toHaveLength(0);
  });

  it("consumes an empty wake without a send", async () => {
    writeFileSync(join(dir, "2026-08-20T13-00-01-0000.md"), "  \n");
    activate(fakePi());
    fire("session_start");
    await vi.waitFor(() => expect(done()).toHaveLength(1));
    expect(sends).toHaveLength(0);
  });

  it("selects files oldest-first on start", async () => {
    writeFileSync(join(dir, "2026-08-20T10-00-01-0000.md"), "second");
    writeFileSync(join(dir, "2026-08-20T10-00-00-0000.md"), "first");
    activate(fakePi());
    fire("session_start");
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    expect(sentBody(0)).toBe("first");
  });
});

describe("inject-bridge — the busy span is the agent RUN, not one turn (#5362)", () => {
  it("turn_end does NOT clear busy — a wake landing between tool calls stays held", async () => {
    // pi fires turn_start/turn_end once per assistant turn inside a run
    // (turnIndex++ per turn, reset at agent_start), so clearing `busy` on
    // turn_end would declare the session idle in the gap between tool calls
    // while the run is still streaming. An order landing in that gap is
    // refused by pi ("Agent is already processing") without the bridge
    // learning. Only agent_settled may clear the flag.
    activate(fakePi());
    fire("session_start");
    fire("agent_start"); // the run begins
    fire("turn_start");
    fire("turn_end"); // one tool-call turn ended — the RUN has not

    writeFileSync(join(dir, "2026-08-21T14-20-59-0031.md"), "ROUND 2 prompt");
    await sleep(150);
    expect(sends).toHaveLength(0); // held, not fired into the streaming run
    expect(pending()).toHaveLength(1);
    expect(done()).toHaveLength(0);

    fire("agent_settled"); // NOW the run is fully settled
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    expect(done()).toHaveLength(0);
    acknowledgeLatest();
    await vi.waitFor(() => expect(done()).toHaveLength(1));
    expect(sentBody(0)).toBe("ROUND 2 prompt");
  });

  it("agent_start alone arms the hold — a run with no inner turn still defers", async () => {
    activate(fakePi());
    fire("session_start");
    fire("agent_start");

    writeFileSync(join(dir, "2026-08-21T14-21-00-0000.md"), "wake");
    await sleep(150);
    expect(sends).toHaveLength(0);
    expect(pending()).toHaveLength(1);
  });

  it("agent_end is not a settle — pi still runs retries/compaction after it", async () => {
    // agent_settled is documented as "after an agent run has fully settled and
    // no automatic retry, compaction, or queued continuation will run". Taking
    // agent_end as the clear would re-open a narrower version of the same
    // window, so it must not be wired as one.
    activate(fakePi());
    fire("session_start");
    fire("agent_start");
    fire("agent_end");

    writeFileSync(join(dir, "2026-08-21T14-21-01-0000.md"), "wake");
    await sleep(150);
    expect(sends).toHaveLength(0);
    expect(pending()).toHaveLength(1);
  });
});

describe("inject-bridge — a delivery is QUEUED, never refused (#5362)", () => {
  it("every send passes deliverAs:followUp so a streaming agent queues it instead of throwing", async () => {
    // The bridge cannot detect a refusal: pi's extension-facing
    // sendUserMessage is declared `: void` and its runtime binding swallows
    // every rejection into an error banner. Start acknowledgement is the
    // correctness boundary; followUp remains a belt that asks Pi to queue if
    // our observed run state was stale.
    writeFileSync(join(dir, "2026-08-21T15-00-00-0000.md"), "round prompt");
    activate(fakePi());
    fire("session_start");

    await vi.waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]!.options?.deliverAs).toBe("followUp");
  });
});

// Canary 9 : an extension's async throw is contained.
//
// Extensions run inside the review session's process. A handler that rejects
// (an OpenViking call timing out, a ledger write failing) must be reported
// through pi's extension error channel and must not fail the turn, end the run
// or surface as an unhandled rejection, which would take the whole worker
// down. The bot's extensions rely on this containment; the OpenViking factory
// adds its own timeout-plus-catch on top, pinned in the last case here
// with a fake client; the others pin what pi itself does.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Type, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionError } from "@earendil-works/pi-coding-agent";
import { type Rig, createRig, useOfflineGuard } from "./harness.js";
import { createOpenViking } from "../../extensions/vendor/openviking-pi/index.js";
import type { OVClient } from "../../extensions/vendor/openviking-pi/client.js";
import { openVikingConfigFromEnv } from "../../extensions/vendor/openviking-pi/qcr-shim.js";

useOfflineGuard();

let rig: Rig;
let unhandled: unknown[];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};

beforeEach(async () => {
  rig = await createRig();
  unhandled = [];
  process.on("unhandledRejection", onUnhandled);
});

afterEach(async () => {
  // Let a stray rejection surface before the listener goes away.
  await new Promise((r) => setTimeout(r, 20));
  process.off("unhandledRejection", onUnhandled);
  rig.close();
  expect(unhandled, "no unhandled rejection escaped an extension").toEqual([]);
});

describe("[canary 9] an extension's async throw is contained", () => {
  it("rejecting handlers on several events are reported and the run completes", async () => {
    const errors: ExtensionError[] = [];
    const slowThrow = async (what: string): Promise<never> => {
      await new Promise((r) => setTimeout(r, 5));
      throw new Error(what);
    };
    const session = await rig.open({
      onExtensionError: (e) => errors.push(e),
      extensionFactories: [
        (pi) => {
          pi.on("agent_start", () => slowThrow("agent_start boom"));
          pi.on("turn_start", () => slowThrow("turn_start boom"));
          pi.on("turn_end", async () => {
            throw new Error("turn_end boom");
          });
        },
      ],
    });
    rig.faux.setResponses([fauxAssistantMessage("finished")]);

    await session.prompt("go");

    expect(session.getLastAssistantText()).toBe("finished");
    expect(new Set(errors.map((e) => e.event))).toEqual(
      new Set(["agent_start", "turn_start", "turn_end"]),
    );
    expect(errors.map((e) => e.error)).toEqual(
      expect.arrayContaining(["agent_start boom", "turn_start boom", "turn_end boom"]),
    );
    for (const e of errors) expect(e.extensionPath).toBeTruthy();
  });

  it("a tool_call handler that throws FAILS CLOSED: the tool does not run, the run goes on", async () => {
    // The one event where pi does not swallow the throw into the error channel:
    // a guard that crashes must never let the call through (bash-guard relies on it).
    const marker = join(rig.dir, "ran");
    const session = await rig.open({
      tools: ["bash"],
      extensionFactories: [
        (pi) => {
          pi.on("tool_call", async () => {
            await new Promise((r) => setTimeout(r, 5));
            throw new Error("guard boom");
          });
        },
      ],
    });
    rig.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: `touch ${marker}` })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("carried on"),
    ]);

    await session.prompt("go");

    expect(existsSync(marker), "the guarded command did not run").toBe(false);
    const result = session.messages.find((m) => m.role === "toolResult") as unknown as
      { isError: boolean; content: { text: string }[] } | undefined;
    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toContain("guard boom");
    expect(session.getLastAssistantText()).toBe("carried on");
  });

  it("a rejecting factory leaves the session usable without that extension's handlers", async () => {
    const seen: string[] = [];
    const session = await rig.open({
      extensionFactories: [
        async () => {
          await new Promise((r) => setTimeout(r, 5));
          throw new Error("factory boom");
        },
        (pi) => {
          pi.on("turn_end", () => {
            seen.push("healthy extension ran");
          });
        },
      ],
    });
    rig.faux.setResponses([fauxAssistantMessage("fine")]);

    await session.prompt("go");

    expect(session.getLastAssistantText()).toBe("fine");
    expect(seen).toEqual(["healthy extension ran"]);
  });

  it("OpenViking's factory, over a fake client that hangs or throws, costs the turn nothing", async () => {
    // Memory failing both ways in one session: the first health probe throws
    // (session_start), the retry in before_agent_start never answers and hits
    // its deadline, and every other call throws. The run finishes, pi's error
    // channel stays quiet because the factory caught its own, and the log says why.
    const log = join(rig.dir, "ov.log");
    let probe = 0;
    const fake = {
      connected: false,
      rekey: null,
      cfg: { user: "reviewer" },
      health: () => {
        probe++;
        return probe === 1
          ? Promise.reject(new Error("socket hang up"))
          : new Promise<boolean>(() => {});
      },
      getSession: () => Promise.reject(new Error("getSession boom")),
      getSessionContext: () => Promise.reject(new Error("context boom")),
      fetchJSON: () => Promise.reject(new Error("fetch boom")),
    } as unknown as OVClient;
    const cfg = {
      ...openVikingConfigFromEnv({
        env: {
          OPENVIKING_CREDENTIAL_SOURCE: "env",
          OPENVIKING_CLI_CONFIG_FILE: join(rig.dir, "none-cli.conf"),
          OPENVIKING_CONFIG_FILE: join(rig.dir, "none.conf"),
        },
        argv: ["node", "pi"],
        cwd: rig.dir,
        home: rig.dir,
        extensionDir: join(
          import.meta.dirname,
          "..",
          "..",
          "extensions",
          "vendor",
          "openviking-pi",
        ),
      }),
      sessionId: "pr-9",
      debugLogFile: log,
      pendingQueue: { dir: join(rig.dir, "pending") },
      hookTimeoutMs: { session_start: 40, before_agent_start: 40 },
      makeClient: () => fake,
    };
    const errors: ExtensionError[] = [];
    const session = await rig.open({
      onExtensionError: (e) => errors.push(e),
      extensionFactories: [createOpenViking(cfg)],
    });
    rig.faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

    await session.prompt("one");
    await session.prompt("two");

    expect(session.getLastAssistantText()).toBe("second");
    expect(errors, "the factory contained its own failures").toEqual([]);
    const lines = readFileSync(log, "utf8");
    expect(lines).toContain("no answer in 40 ms");
    expect(lines).toContain("socket hang up");
  });

  it("a tool that throws becomes an error result and the model gets its next turn", async () => {
    const session = await rig.open({
      tools: ["flaky"],
      customTools: [
        {
          name: "flaky",
          label: "flaky",
          description: "always fails",
          parameters: Type.Object({}),
          execute: async () => {
            await new Promise((r) => setTimeout(r, 5));
            throw new Error("tool boom");
          },
        },
      ],
    });
    rig.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("flaky", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("recovered"),
    ]);

    await session.prompt("go");

    expect(session.getLastAssistantText()).toBe("recovered");
    const result = session.messages.find((m) => m.role === "toolResult") as unknown as
      { isError: boolean; content: { text: string }[] } | undefined;
    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toContain("tool boom");
  });
});
